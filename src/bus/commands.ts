import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { executeCommand } from "../connectors/runtime.js";
import { BusCommandResult, busStore } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type Seen = {
  id: string;
  at: number;
  result: BusCommandResult;
};

let logPath: string | undefined;
let seen = new Map<string, Seen>();
let writing: Promise<void> = Promise.resolve();
let pending: Promise<void> = Promise.resolve();

export function waitForCommands() {
  return pending;
}

export function setCommandLogPath(path: string | undefined) {
  logPath = path;
  seen = new Map();
}

export async function loadCommandLog() {
  if (!logPath) return;
  try {
    const parsed = JSON.parse(await readFile(logPath, "utf8")) as Seen[];
    const cutoff = Date.now() - DAY_MS;
    seen = new Map(
      parsed.filter((item) => item.at >= cutoff).map((item) => [item.id, item]),
    );
  } catch {
    seen = new Map();
  }
}

export function commandResultFor(id: string) {
  return seen.get(id)?.result;
}

export async function acceptCommand(raw: unknown): Promise<
  | { status: 400; body: { error: string } }
  | { status: 202; body: { commandId: string } }
> {
  if (!raw || typeof raw !== "object") return { status: 400, body: { error: "invalid_command" } };
  const command = raw as Record<string, unknown>;
  const id = command.id;
  const kind = command.kind;
  if (typeof id !== "string" || !id || typeof kind !== "string" || !kind) {
    return { status: 400, body: { error: "invalid_command" } };
  }
  if (command[kind] === undefined) return { status: 400, body: { error: "invalid_command" } };
  const existing = seen.get(id);
  if (existing) return { status: 202, body: { commandId: id } };

  const placeholder: BusCommandResult = {
    commandId: id,
    ok: false,
    error: "pending",
    finishedAt: new Date().toISOString(),
  };
  seen.set(id, { id, at: Date.now(), result: placeholder });
  const job = executeCommand(command).then((result) => {
    seen.set(id, { id, at: Date.now(), result });
    busStore.recordResult(result);
    writing = persist();
  });
  pending = pending.then(() => job.then(() => undefined, () => undefined));
  return { status: 202, body: { commandId: id } };
}

export function flushCommandLog() {
  return writing;
}

async function persist() {
  if (!logPath) return;
  const cutoff = Date.now() - DAY_MS;
  const records = [...seen.values()].filter((item) => item.at >= cutoff);
  seen = new Map(records.map((item) => [item.id, item]));
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, `${JSON.stringify(records)}\n`, { mode: 0o600 });
}
