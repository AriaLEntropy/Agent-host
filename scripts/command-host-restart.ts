import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createChecks,
  createHarness,
  jsonBody,
  sleep,
  type SealedTunnel,
} from "./lib/sealed-harness.js";

type Recorded = { id: string; at: number; result: { commandId: string; ok: boolean; error?: string; finishedAt: string } };

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

async function records(path: string): Promise<Recorded[]> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Recorded[];
  } catch {
    return [];
  }
}

async function waitForRecord(path: string, id: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await records(path)).find((item) => item.id === id);
    if (found && found.result?.error !== "pending") return found;
    await sleep(50);
  }
  throw new Error(`command ${id} was not persisted within ${timeoutMs}ms`);
}

async function hash(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function main() {
  const harness = await createHarness({
    hostName: "Restart Host",
    hostProcess: true,
    commandLog: true,
  });
  const { check, finish } = createChecks();
  const id = `restart-${randomUUID()}`;

  try {
    if (!harness.commandLogPath) throw new Error("command log path is not configured");
    const first = await send(harness.tunnel, id);
    check("command accepted before restart", first.status === 202, `status=${first.status}`);
    const firstRecord = await waitForRecord(harness.commandLogPath, id);
    check(
      "command persisted before restart",
      firstRecord.result.commandId === id,
      `ok=${firstRecord.result.ok} error=${String(firstRecord.result.error)}`,
    );
    const before = await hash(harness.commandLogPath);
    const oldPid = harness.hostPid;

    await harness.restartHost!();
    check(
      "host process restarted",
      harness.hostPid !== undefined && harness.hostPid !== oldPid,
      `old=${String(oldPid)} new=${String(harness.hostPid)}`,
    );

    const afterTunnel = await harness.openTunnel();
    const again = await send(afterTunnel, id);
    check("same id accepted after restart", again.status === 202, `status=${again.status}`);
    await sleep(500);
    const after = await hash(harness.commandLogPath);
    const afterRecords = await records(harness.commandLogPath);
    check(
      "same id was not executed again",
      before === after && afterRecords.filter((item) => item.id === id).length === 1,
      `sha256=${after.slice(0, 12)}... records=${afterRecords.filter((item) => item.id === id).length}`,
    );

    const otherId = `restart-${randomUUID()}`;
    const other = await send(afterTunnel, otherId);
    check("new id accepted after restart", other.status === 202, `status=${other.status}`);
    await waitForRecord(harness.commandLogPath, otherId);
    check(
      "new id executes after restart",
      (await records(harness.commandLogPath)).filter((item) => item.id === otherId).length === 1,
      `id=${otherId.slice(0, 16)}...`,
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
