import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { flushCommandLog } from "../src/bus/commands.js";
import {
  createChecks,
  createHarness,
  jsonBody,
  sleep,
  type SealedTunnel,
} from "./lib/sealed-harness.js";

type CommandResult = {
  commandId: string;
  ok: boolean;
  error?: string;
  finishedAt?: string;
};

function command(id: string) {
  return {
    id,
    kind: "remoteControl",
    remoteControl: { taskId: "smoke-missing-task" },
  };
}

async function send(tunnel: SealedTunnel, id: string) {
  const response = await tunnel.request(
    "POST",
    "/bus/commands",
    Buffer.from(JSON.stringify(command(id))),
  );
  return { status: response.status, body: jsonBody(response) };
}

async function recentResults(tunnel: SealedTunnel): Promise<CommandResult[]> {
  const response = await tunnel.request("GET", "/bus/snapshot");
  const results = jsonBody(response).recentResults;
  return Array.isArray(results) ? (results as CommandResult[]) : [];
}

async function waitForResult(
  tunnel: SealedTunnel,
  id: string,
  timeoutMs = 5_000,
): Promise<CommandResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = (await recentResults(tunnel)).find((item) => item.commandId === id);
    if (result && result.error !== "pending") return result;
    await sleep(100);
  }
  throw new Error(`command ${id} did not produce a result within ${timeoutMs}ms`);
}

function executions(results: CommandResult[], id: string) {
  return results.filter((item) => item.commandId === id).length;
}

async function fileHash(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function runSecondProcess(logPath: string, id: string) {
  const script = fileURLToPath(new URL("./lib/command-restart-child.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", script, logPath, id], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  if (code !== 0)
    throw new Error(`second process exited ${code}: ${stderr.trim() || stdout.trim()}`);
  const lines = stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]) as {
    status: number;
    before: string | null;
    after: string | null;
  };
}

async function main() {
  const harness = await createHarness({ commandLog: true });
  const tunnel = harness.tunnel;
  const { check, finish } = createChecks();

  try {
    const id = `smoke-${randomUUID()}`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sent = await send(tunnel, id);
      statuses.push(sent.status);
      check(
        `send #${attempt + 1} same id`,
        sent.status === 202 && sent.body.commandId === id,
        `status=${sent.status} commandId=${String(sent.body.commandId)}`,
      );
    }

    const first = await waitForResult(tunnel, id);
    const afterThree = await recentResults(tunnel);
    check(
      "command executed once",
      executions(afterThree, id) === 1,
      `accepted=${statuses.join(",")} executions=${executions(afterThree, id)} result=${String(first.error)}`,
    );

    await flushCommandLog();
    if (!harness.commandLogPath) throw new Error("command log path is not configured");
    const beforeRestart = await fileHash(harness.commandLogPath);
    const restarted = await runSecondProcess(harness.commandLogPath, id);
    const afterRestart = await fileHash(harness.commandLogPath);
    check(
      "same id in a real second process",
      restarted.status === 202 &&
        restarted.before !== null &&
        restarted.before === restarted.after,
      `status=${restarted.status} before=${String(restarted.before)} after=${String(restarted.after)}`,
    );
    check(
      "command log unchanged after the second process",
      beforeRestart === afterRestart,
      `sha256=${beforeRestart.slice(0, 12)}...`,
    );

    const otherId = `smoke-${randomUUID()}`;
    const other = await send(tunnel, otherId);
    await waitForResult(tunnel, otherId);
    const withOther = await recentResults(tunnel);
    check(
      "a different id still executes",
      other.status === 202 &&
        executions(withOther, otherId) === 1 &&
        executions(withOther, id) === 1,
      `status=${other.status} first=${executions(withOther, id)} second=${executions(withOther, otherId)}`,
    );
  } finally {
    await harness.close();
  }

  finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
