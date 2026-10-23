import { fileURLToPath } from "node:url";
import { busStore } from "../src/bus/store.js";
import { resetRuntime, useAgents } from "../src/connectors/runtime.js";
import {
  createChecks,
  createHarness,
  jsonBody,
  sleep,
  type BusSocket,
  type SealedTunnel,
} from "./lib/sealed-harness.js";

const fakeAcp = fileURLToPath(new URL("../test/fixtures/fake-acp.mjs", import.meta.url));

function startTaskCommand(id: string) {
  return {
    id,
    kind: "startTask",
    startTask: {
      source: "acp",
      connectorId: "fake",
      projectPath: process.cwd(),
      prompt: "ECHO:ok",
    },
  };
}

async function waitForState(tunnel: SealedTunnel, commandId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = jsonBody(await tunnel.request("GET", "/bus/snapshot"));
  for (;;) {
    const result = snapshot.recentResults?.find(
      (item: Record<string, unknown>) => item.commandId === commandId,
    );
    const task = snapshot.tasks?.find((item: Record<string, unknown>) =>
      String(item.id).startsWith("acp:fake:"),
    );
    if (result && task?.status === "completed") return { snapshot, result, task };
    if (Date.now() >= deadline) return { snapshot, result, task };
    await sleep(100);
    snapshot = jsonBody(await tunnel.request("GET", "/bus/snapshot"));
  }
}

async function waitForTaskUpdated(socket: BusSocket, deadline: number) {
  while (Date.now() < deadline) {
    const message = await socket.next(Math.max(1, deadline - Date.now()));
    if (
      message.type === "event" &&
      message.event?.kind === "taskUpdated" &&
      String(message.event?.task?.id ?? "").startsWith("acp:fake:")
    ) {
      return message;
    }
  }
  return undefined;
}

async function main() {
  const harness = await createHarness({ hostName: "Bus M1 Host" });
  const { check, finish } = createChecks();
  let socketA: BusSocket | undefined;
  let socketB: BusSocket | undefined;

  try {
    useAgents(
      [
        {
          id: "fake",
          kind: "acp",
          name: "Fake ACP",
          executable: process.execPath,
          args: [fakeAcp],
          env: {},
          origin: "manifest",
          available: true,
          enabled: true,
        },
      ],
      true,
    );

    const second = await harness.openTunnel();
    socketA = await harness.tunnel.openSocket("/bus/ws");
    socketB = await second.openSocket("/bus/ws");
    const initialA = await socketA.next(3_000);
    const initialB = await socketB.next(3_000);
    check(
      "WS initial snapshot has one online agent",
      initialA.type === "snapshot" && initialA.snapshot?.agents?.[0]?.online === true,
      `type=${String(initialA.type)} agents=${initialA.snapshot?.agents?.length}`,
    );
    check(
      "two WS clients see the same initial seq",
      initialA.snapshot?.seq === initialB.snapshot?.seq,
      `seqA=${String(initialA.snapshot?.seq)} seqB=${String(initialB.snapshot?.seq)}`,
    );

    // M1-04: the same command id three times must execute once.
    const commandId = `m1-bus-${Date.now()}`;
    const startedAt = performance.now();
    const posted = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      posted.push(
        await harness.tunnel.request(
          "POST",
          "/bus/commands",
          Buffer.from(JSON.stringify(startTaskCommand(commandId))),
        ),
      );
    }
    check(
      "same command id accepted three times",
      posted.every((response) => response.status === 202),
      `statuses=${posted.map((response) => response.status).join(",")}`,
    );

    const [eventA, eventB] = await Promise.all([
      waitForTaskUpdated(socketA, Date.now() + 3_000),
      waitForTaskUpdated(socketB, Date.now() + 3_000),
    ]);
    const elapsed = performance.now() - startedAt;
    check(
      "taskUpdated reaches both clients",
      Boolean(eventA) && Boolean(eventB),
      `a=${Boolean(eventA)} b=${Boolean(eventB)}`,
    );
    check("taskUpdated arrives in under 2s", elapsed < 2_000, `elapsed=${elapsed.toFixed(1)}ms`);

    const { snapshot, result, task } = await waitForState(harness.tunnel, commandId);
    check("commandResult ok=true", result?.ok === true, `ok=${String(result?.ok)}`);
    check(
      "exactly one fake ACP task was created",
      snapshot.tasks?.filter((item: Record<string, unknown>) =>
        String(item.id).startsWith("acp:fake:"),
      ).length === 1,
      `tasks=${snapshot.tasks?.length}`,
    );
    check("task completed", task?.status === "completed", `status=${String(task?.status)}`);
    check("snapshot has agents=1", snapshot.agents?.length === 1, `agents=${snapshot.agents?.length}`);
    check("snapshot has tasks>=1", (snapshot.tasks?.length ?? 0) >= 1, `tasks=${snapshot.tasks?.length}`);
    check(
      "snapshot has projects>=1",
      (snapshot.projects?.length ?? 0) >= 1,
      `projects=${snapshot.projects?.length}`,
    );
    check("snapshot seq>=1", Number(snapshot.seq) >= 1, `seq=${String(snapshot.seq)}`);

    const seqA = jsonBody(await harness.tunnel.request("GET", "/bus/snapshot")).seq;
    const seqB = jsonBody(await second.request("GET", "/bus/snapshot")).seq;
    check("both clients see the same seq", seqA === seqB, `seqA=${String(seqA)} seqB=${String(seqB)}`);

    const unchanged = await harness.tunnel.request(
      "GET",
      `/bus/snapshot?since=${String(seqA)}`,
      undefined,
      30_000,
    );
    check("long poll with current seq returns 304", unchanged.status === 304, `status=${unchanged.status}`);

    // M1-04: malformed JSON and unsupported command kinds.
    const malformed = await harness.tunnel.request(
      "POST",
      "/bus/commands",
      Buffer.from("{not-json"),
    );
    check("malformed JSON returns 400", malformed.status === 400, `status=${malformed.status}`);

    const unsupportedId = `m1-unsupported-${Date.now()}`;
    const unsupported = await harness.tunnel.request(
      "POST",
      "/bus/commands",
      Buffer.from(
        JSON.stringify({
          id: unsupportedId,
          kind: "remoteControl",
          remoteControl: { taskId: "missing" },
        }),
      ),
    );
    check("unsupported kind is accepted then failed", unsupported.status === 202, `status=${unsupported.status}`);
    const unsupportedState = await waitForState(harness.tunnel, unsupportedId, 5_000);
    check(
      "unsupported kind returns ok=false with readable error",
      unsupportedState.result?.ok === false && typeof unsupportedState.result?.error === "string",
      `ok=${String(unsupportedState.result?.ok)} error=${String(unsupportedState.result?.error)}`,
    );

    // M1-03: the wire snapshot caps projects at 60.
    const agentId = busStore.agentId() || "smoke-agent";
    for (let index = 0; index < 61; index += 1) {
      busStore.rememberProject({
        agentId,
        path: `C:\\m1-project-${index}`,
        name: `m1-project-${index}`,
        lastUsedAt: new Date().toISOString(),
        pinned: false,
      });
    }
    const limited = jsonBody(await harness.tunnel.request("GET", "/bus/snapshot"));
    check(
      "snapshot keeps at most 60 projects",
      limited.projects?.length === 60,
      `projects=${limited.projects?.length}`,
    );
  } finally {
    resetRuntime();
    socketA?.close();
    socketB?.close();
    await sleep(100);
    await harness.close();
  }

  finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
