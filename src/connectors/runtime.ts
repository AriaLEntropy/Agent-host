import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { basename, delimiter, dirname } from "node:path";
import { homedir } from "node:os";
import {
  busStore,
  type BusCommandResult,
  type BusMessage,
  type BusTask,
  type ListedAgent,
} from "../bus/store.js";
import { discoverAgents, type AgentSpec } from "./discover.js";

export const INITIALIZE_TIMEOUT_MS = 10_000;
export const IDLE_MS = 10 * 60 * 1000;
const MAX_USER_MESSAGES = 40;
const MAX_TOOL_MESSAGES = 160;

export class AcpTimeout extends Error {}
export class AcpAuthRequired extends Error {}
export class AcpRejected extends Error {}

type PermissionOption = { optionId: string; kind: string };

type LiveSession = {
  taskId: string;
  sessionId: string;
  cwd: string;
  messages: BusMessage[];
  agentText: string;
  permission?: { rpcId: number; options: PermissionOption[] };
};

type RpcResult = { result?: unknown; error?: { code?: number; message?: string } };

export class AcpProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private idleTimer: NodeJS.Timeout | undefined;
  private stderrTail = "";
  readonly capabilities = { loadSession: false, resume: false, image: false };
  alive = false;

  constructor(
    private readonly executable: string,
    private readonly args: string[],
    private readonly extraEnv: Record<string, string>,
    private readonly onLineEvent: (message: Record<string, unknown>) => void,
    private readonly onExit: () => void,
    private readonly idleMs: number,
  ) {}

  async start() {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.extraEnv };
    env.PATH = `${dirname(this.executable)}${delimiter}${env.PATH ?? ""}`;
    const ext = this.executable.slice(this.executable.lastIndexOf(".")).toLowerCase();
    const child = spawn(this.executable, this.args, {
      env,
      shell: ext === ".cmd" || ext === ".bat",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.alive = true;
    child.stdin.on("error", () => undefined);
    this.armIdle();
    createInterface({ input: child.stdout }).on("line", (line) => {
      this.armIdle();
      this.onLine(line);
    });
    child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-2000);
    });
    child.on("exit", () => {
      this.alive = false;
      const detail = this.stderrTail.trim();
      this.failAll(new AcpRejected(detail ? `agent exited: ${detail}` : "agent exited"));
      this.onExit();
    });
    const result = (await this.call(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "agent-host", version: "1.0" },
      },
      INITIALIZE_TIMEOUT_MS,
    )) as Record<string, unknown>;
    if (result.protocolVersion !== 1) {
      this.kill();
      throw new AcpRejected("unsupported ACP version");
    }
    const agentCaps = record(result.agentCapabilities);
    const promptCaps = record(result.promptCapabilities);
    const sessionCaps = record(agentCaps.sessionCapabilities);
    this.capabilities.loadSession = agentCaps.loadSession === true;
    this.capabilities.resume = sessionCaps.resume === true;
    this.capabilities.image = promptCaps.image === true;
  }

  call(method: string, params: unknown, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpTimeout(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  respond(id: number, result: unknown) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  kill() {
    clearTimeout(this.idleTimer);
    this.alive = false;
    this.child?.kill();
  }

  private send(message: unknown) {
    this.armIdle();
    if (!this.child?.stdin.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The child may have exited between the writable check and the write.
    }
  }

  private armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.kill(), this.idleMs);
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.method === "string" && typeof message.id === "number") {
      this.onLineEvent(message);
      return;
    }
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      const body = message as RpcResult;
      if (body.error) {
        waiter.reject(
          body.error.code === -32000
            ? new AcpAuthRequired(body.error.message ?? "auth required")
            : new AcpRejected(body.error.message ?? "ACP error"),
        );
        return;
      }
      waiter.resolve(body.result);
      return;
    }
    if (typeof message.method === "string") this.onLineEvent(message);
  }

  private failAll(error: Error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

const specs: AgentSpec[] = [];
const hiddenRegistryIds = new Set<string>();
const processes = new Map<string, AcpProcess>();
const sessions = new Map<string, LiveSession>();
let idleMs = IDLE_MS;

export function useAgents(agents: AgentSpec[], announce = false) {
  specs.splice(0, specs.length, ...agents);
  busStore.setAgents(agents.map(listed), announce);
}

export function resetRuntime() {
  for (const process of processes.values()) process.kill();
  processes.clear();
  sessions.clear();
  hiddenRegistryIds.clear();
  specs.splice(0, specs.length);
  idleMs = IDLE_MS;
  busStore.setAgents([]);
}

export function setIdleMs(ms: number) {
  idleMs = ms;
}

export async function refreshAgents() {
  const found = await discoverAgents({ hiddenRegistryIds });
  useAgents(found.agents, true);
  return found;
}

export function executeCommand(command: Record<string, unknown>): Promise<BusCommandResult> {
  const id = String(command.id);
  const kind = String(command.kind);
  const finishedAt = () => new Date().toISOString();
  const fail = (error: string): BusCommandResult => ({ commandId: id, ok: false, error, finishedAt: finishedAt() });
  if (kind === "remoteControl" || kind === "fetchChanges" || kind === "mergeWorktree") {
    return Promise.resolve(fail("not supported"));
  }
  if (kind === "startTask") return startTask(id, record(command.startTask)).catch((error) => fail(messageOf(error)));
  if (kind === "followUp") return followUp(id, record(command.followUp)).catch((error) => fail(messageOf(error)));
  if (kind === "approve") return approve(id, record(command.approve)).catch((error) => fail(messageOf(error)));
  if (kind === "interrupt") return interrupt(id, record(command.interrupt)).catch((error) => fail(messageOf(error)));
  if (kind === "fetchMessages") return fetchMessages(id, record(command.fetchMessages)).catch((error) => fail(messageOf(error)));
  return Promise.resolve(fail("no connector is available"));
}

async function startTask(commandId: string, payload: Record<string, unknown>): Promise<BusCommandResult> {
  const source = payload.source;
  const spec =
    source === "dsh"
      ? specs.find((agent) => agent.kind === "dsh")
      : source === "acp"
        ? specs.find((agent) => agent.kind === "acp" && agent.id === payload.connectorId)
        : undefined;
  if (!spec) return done(commandId, false, "no connector is available");
  if (!spec.available || !spec.executable) return done(commandId, false, spec.lastError ?? "no connector is available");
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const process = await ensureProcess(spec);
  if (attachments.length > 0 && !process.capabilities.image) {
    return done(commandId, false, "image is not supported");
  }
  if (attachments.length > 0) return done(commandId, false, "image bytes are not available");
  const cwd = typeof payload.projectPath === "string" && payload.projectPath.trim() ? payload.projectPath : homedir();
  const created = record(await process.call("session/new", { cwd, mcpServers: [] }));
  const sessionId = typeof created.sessionId === "string" ? created.sessionId : "";
  if (!sessionId) return done(commandId, false, "session/new did not return a session id");
  const taskId = spec.kind === "dsh" ? `dsh:${sessionId}` : `acp:${spec.id}:${sessionId}`;
  const now = new Date().toISOString();
  const task = baseTask(spec, taskId, cwd, prompt.slice(0, 80) || "新任务", now);
  sessions.set(taskId, { taskId, sessionId, cwd, messages: [], agentText: "" });
  busStore.rememberProject({
    agentId: task.agentId,
    path: cwd,
    name: task.projectName,
    lastUsedAt: now,
    pinned: false,
  });
  busStore.upsertTask(task);
  void runPrompt(process, taskId, commandId, prompt).catch((error) => markFailed(taskId, messageOf(error)));
  return { commandId, ok: true, taskId, finishedAt: now };
}

async function followUp(commandId: string, payload: Record<string, unknown>): Promise<BusCommandResult> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  const session = sessions.get(taskId);
  const task = busStore.taskById(taskId);
  if (!session || !task) return done(commandId, false, "task not found");
  const spec = specForTask(task);
  if (!spec?.executable) return done(commandId, false, "no connector is available");
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  let process = processes.get(processKey(spec));
  if (!process?.alive) {
    process = await ensureProcess(spec);
    if (process.capabilities.loadSession) await process.call("session/load", { sessionId: session.sessionId, cwd: session.cwd, mcpServers: [] });
    else if (process.capabilities.resume) await process.call("session/resume", { sessionId: session.sessionId, cwd: session.cwd, mcpServers: [] });
    else return done(commandId, false, "session cannot be restored");
  }
  if (attachments.length > 0 && !process.capabilities.image) return done(commandId, false, "image is not supported");
  if (attachments.length > 0) return done(commandId, false, "image bytes are not available");
  void runPrompt(process, taskId, commandId, prompt).catch((error) => markFailed(taskId, messageOf(error)));
  return done(commandId, true, undefined, taskId);
}

async function approve(commandId: string, payload: Record<string, unknown>): Promise<BusCommandResult> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  const session = sessions.get(taskId);
  const task = busStore.taskById(taskId);
  if (!session?.permission || !task) return done(commandId, false, "task not found");
  const allow = payload.decision !== "deny";
  const preferred = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  const option = preferred
    .map((kind) => session.permission?.options.find((item) => item.kind === kind))
    .find(Boolean);
  if (!option) return done(commandId, false, "no matching permission option");
  const spec = specForTask(task);
  const process = spec ? processes.get(processKey(spec)) : undefined;
  if (!process?.alive) return done(commandId, false, "agent is not running");
  process.respond(session.permission.rpcId, { outcome: { outcome: "selected", optionId: option.optionId } });
  session.permission = undefined;
  busStore.upsertTask({ ...task, status: "running", pendingRequest: undefined, updatedAt: new Date().toISOString() });
  return done(commandId, true, undefined, taskId);
}

async function interrupt(commandId: string, payload: Record<string, unknown>): Promise<BusCommandResult> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  const task = busStore.taskById(taskId);
  const session = sessions.get(taskId);
  if (!task || !session) return done(commandId, false, "task not found");
  const spec = specForTask(task);
  const process = spec ? processes.get(processKey(spec)) : undefined;
  process?.notify("session/cancel", { sessionId: session.sessionId });
  if (session.permission && process?.alive) {
    process.respond(session.permission.rpcId, { outcome: { outcome: "cancelled" } });
    session.permission = undefined;
  }
  busStore.upsertTask({ ...withoutPending(task), status: "interrupted", updatedAt: new Date().toISOString() });
  return done(commandId, true, undefined, taskId);
}

async function fetchMessages(commandId: string, payload: Record<string, unknown>): Promise<BusCommandResult> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  const session = sessions.get(taskId);
  const task = busStore.taskById(taskId);
  if (!session || !task) return done(commandId, false, "task not found");
  const userAndAgent = session.messages.filter((message) => message.role !== "tool");
  const tools = session.messages.filter((message) => message.role === "tool");
  const messages = [...userAndAgent.slice(-MAX_USER_MESSAGES), ...tools.slice(-MAX_TOOL_MESSAGES)];
  busStore.emitTaskMessages({
    taskId,
    agentId: task.agentId,
    messages,
    hasMore: messages.length < session.messages.length,
    fetchedAt: new Date().toISOString(),
  });
  return done(commandId, true, undefined, taskId);
}

async function ensureProcess(spec: AgentSpec) {
  const key = processKey(spec);
  const existing = processes.get(key);
  if (existing?.alive) return existing;
  if (!spec.executable) throw new AcpRejected("no executable");
  const process = new AcpProcess(
    spec.executable,
    spec.args,
    spec.env,
    (message) => onAgentMessage(spec, message),
    () => failOpenTasks(spec),
    idleMs,
  );
  try {
    await process.start();
  } catch (error) {
    process.kill();
    if (spec.origin === "registry" && !(error instanceof AcpTimeout) && !(error instanceof AcpAuthRequired)) {
      hiddenRegistryIds.add(spec.id);
      spec.available = false;
      spec.lastError = messageOf(error);
      useAgents(specs.filter((agent) => agent.origin !== "registry" || !hiddenRegistryIds.has(agent.id)));
    }
    throw error;
  }
  processes.set(key, process);
  return process;
}

function onAgentMessage(spec: AgentSpec, message: Record<string, unknown>) {
  if (message.method === "session/update") {
    const params = record(message.params);
    const update = record(params.update);
    const session = sessionByAcpId(typeof params.sessionId === "string" ? params.sessionId : "");
    if (!session) return;
    applyUpdate(session, update);
    return;
  }
  if (message.method !== "session/request_permission" || typeof message.id !== "number") return;
  const params = record(message.params);
  const session = sessionByAcpId(typeof params.sessionId === "string" ? params.sessionId : "");
  const task = session ? busStore.taskById(session.taskId) : undefined;
  if (!session || !task) return;
  const tool = record(params.toolCall);
  const options = Array.isArray(params.options)
    ? params.options.map((item) => record(item)).filter((item) => typeof item.optionId === "string" && typeof item.kind === "string")
    : [];
  session.permission = {
    rpcId: message.id,
    options: options as PermissionOption[],
  };
  const toolKind = tool.kind;
  const pendingKind = toolKind === "execute" ? "command" : toolKind === "edit" || toolKind === "delete" || toolKind === "move" ? "fileChange" : "permission";
  const detail = JSON.stringify(tool.rawInput ?? tool).slice(0, 2000);
  busStore.upsertTask({
    ...task,
    status: "waitingApproval",
    pendingRequest: {
      id: typeof tool.toolCallId === "string" ? tool.toolCallId : String(message.id),
      kind: pendingKind,
      summary: typeof tool.title === "string" ? tool.title.slice(0, 200) : "permission",
      detail,
    },
    updatedAt: new Date().toISOString(),
  });
  void spec;
}

function applyUpdate(session: LiveSession, update: Record<string, unknown>) {
  const task = busStore.taskById(session.taskId);
  if (!task) return;
  const kind = update.sessionUpdate;
  const now = new Date().toISOString();
  if (kind === "agent_message_chunk") {
    const text = record(update.content).text;
    if (typeof text === "string") session.agentText += text;
    const last = session.messages.at(-1);
    if (last?.role === "agent") last.text = session.agentText;
    else session.messages.push({ id: `agent:${session.sessionId}`, role: "agent", text: session.agentText, createdAt: now });
    busStore.upsertTask({ ...task, lastMessage: session.agentText.slice(0, 500), updatedAt: now });
    return;
  }
  if (kind === "session_info_update" && typeof update.title === "string") {
    busStore.upsertTask({ ...task, title: update.title.slice(0, 80), updatedAt: now });
    return;
  }
  if (kind === "tool_call") {
    const title = typeof update.title === "string" ? update.title : "tool";
    session.messages.push({
      id: typeof update.toolCallId === "string" ? update.toolCallId : `tool:${session.messages.length}`,
      role: "tool",
      text: title,
      createdAt: now,
    });
  }
}

async function runPrompt(process: AcpProcess, taskId: string, commandId: string, prompt: string) {
  const session = sessions.get(taskId);
  const task = busStore.taskById(taskId);
  if (!session || !task) return;
  const now = new Date().toISOString();
  session.agentText = "";
  session.messages.push({ id: `user:${commandId}`, role: "user", text: prompt, createdAt: now });
  busStore.upsertTask({ ...withoutPending(task), status: "running", updatedAt: now });
  const result = record(
    await process.call("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: prompt }],
    }),
  );
  const current = busStore.taskById(taskId);
  if (!current) return;
  const stop = result.stopReason;
  const status = stop === "end_turn" ? "completed" : stop === "cancelled" ? "interrupted" : "failed";
  busStore.upsertTask({ ...withoutPending(current), status, updatedAt: new Date().toISOString() });
}

function failOpenTasks(spec: AgentSpec) {
  for (const session of sessions.values()) {
    const task = busStore.taskById(session.taskId);
    if (!task || specForTask(task)?.id !== spec.id || specForTask(task)?.kind !== spec.kind) continue;
    if (task.status === "running" || task.status === "waitingApproval") markFailed(session.taskId, "agent exited");
  }
}

function markFailed(taskId: string, error: string) {
  const task = busStore.taskById(taskId);
  if (!task) return;
  busStore.upsertTask({
    ...withoutPending(task),
    status: "failed",
    lastMessage: error.slice(0, 500),
    updatedAt: new Date().toISOString(),
  });
}

function specForTask(task: BusTask) {
  if (task.source === "dsh") return specs.find((agent) => agent.kind === "dsh");
  return specs.find((agent) => agent.kind === "acp" && agent.id === task.connectorId);
}

function sessionByAcpId(sessionId: string) {
  for (const session of sessions.values()) if (session.sessionId === sessionId) return session;
  return undefined;
}

function processKey(spec: AgentSpec) {
  return `${spec.kind}:${spec.id}`;
}

function baseTask(spec: AgentSpec, taskId: string, cwd: string, title: string, now: string): BusTask {
  return {
    id: taskId,
    agentId: busStore.agentId(),
    source: spec.kind,
    ...(spec.kind === "acp" ? { connectorId: spec.id } : {}),
    title,
    projectPath: cwd,
    projectName: basename(cwd) || cwd,
    status: "running",
    origin: "watch",
    controllable: true,
    startedAt: now,
    updatedAt: now,
  };
}

function withoutPending(task: BusTask): BusTask {
  const next = { ...task };
  delete next.pendingRequest;
  return next;
}

function listed(agent: AgentSpec): ListedAgent {
  return {
    id: agent.id,
    kind: agent.kind,
    name: agent.name,
    available: agent.available,
    enabled: agent.enabled,
    lastError: agent.lastError,
  };
}

function done(commandId: string, ok: boolean, error?: string, taskId?: string): BusCommandResult {
  return { commandId, ok, ...(error ? { error } : {}), ...(taskId ? { taskId } : {}), finishedAt: new Date().toISOString() };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "agent failed";
}
