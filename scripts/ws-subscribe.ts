import { busStore, type BusTask } from "../src/bus/store.js";
import {
  createChecks,
  createHarness,
  jsonBody,
  sleep,
  type BusSocket,
} from "./lib/sealed-harness.js";

function taskAt(index: number, now: number): BusTask {
  const updatedAt = new Date(now - index * 1_000).toISOString();
  return {
    id: `smoke:task-${index + 1}`,
    agentId: busStore.agentId() || "smoke-agent",
    source: "acp",
    title: `smoke task ${index + 1}`,
    projectPath: "C:\\smoke",
    projectName: "smoke",
    status: "running",
    origin: "watch",
    controllable: true,
    startedAt: updatedAt,
    updatedAt,
  };
}

async function main() {
  const harness = await createHarness({ hostName: "Bus WS Host" });
  const { check, finish } = createChecks();
  let socketA: BusSocket | undefined;
  let socketB: BusSocket | undefined;

  try {
    const second = await harness.openTunnel();
    socketA = await harness.tunnel.openSocket("/bus/ws");
    socketB = await second.openSocket("/bus/ws");

    const initialA = await socketA.next(3_000);
    const initialB = await socketB.next(3_000);
    check(
      "new connection gets a full snapshot",
      initialA.type === "snapshot" &&
        Array.isArray(initialA.snapshot?.agents) &&
        initialA.snapshot.agents.length === 1 &&
        initialA.snapshot.agents[0]?.online === true,
      `type=${String(initialA.type)} agents=${initialA.snapshot?.agents?.length} seq=${String(initialA.snapshot?.seq)}`,
    );
    check(
      "two clients receive the same snapshot",
      initialB.type === "snapshot" && initialB.snapshot?.seq === initialA.snapshot?.seq,
      `seqA=${String(initialA.snapshot?.seq)} seqB=${String(initialB.snapshot?.seq)}`,
    );

    const now = Date.now();
    const task = taskAt(0, now);
    const startedAt = performance.now();
    busStore.upsertTask(task);
    const [eventA, eventB] = await Promise.all([socketA.next(2_000), socketB.next(2_000)]);
    const elapsed = performance.now() - startedAt;
    check(
      "taskUpdated reaches the first client",
      eventA.type === "event" &&
        eventA.event?.kind === "taskUpdated" &&
        eventA.event?.task?.id === task.id,
      `kind=${String(eventA.event?.kind)} id=${String(eventA.event?.task?.id)}`,
    );
    check(
      "taskUpdated reaches the second client",
      eventB.type === "event" &&
        eventB.event?.kind === "taskUpdated" &&
        eventB.event?.task?.id === task.id,
      `kind=${String(eventB.event?.kind)} id=${String(eventB.event?.task?.id)}`,
    );
    check(
      "event delivered in under 2s",
      elapsed < 2_000,
      `elapsed=${elapsed.toFixed(1)}ms`,
    );

    const snapshotAfter = await harness.tunnel.request("GET", "/bus/snapshot");
    const seqAfter = jsonBody(snapshotAfter).seq;
    const snapshotAgain = await harness.tunnel.request("GET", "/bus/snapshot");
    const seqAgain = jsonBody(snapshotAgain).seq;
    check(
      "seq increments once per event",
      seqAfter === 1 && seqAgain === 1,
      `afterEvent=${String(seqAfter)} afterSecondSnapshot=${String(seqAgain)}`,
    );

    busStore.replaceForMeasurement(
      Array.from({ length: 401 }, (_, index) => taskAt(index + 1, now)),
      [],
    );
    const limitSocket = await second.openSocket("/bus/ws?since=-1");
    try {
      const limited = await limitSocket.next(3_000);
      const tasks: BusTask[] = Array.isArray(limited.snapshot?.tasks) ? limited.snapshot.tasks : [];
      const descending = tasks.every(
        (item, index) => index === 0 || tasks[index - 1].updatedAt >= item.updatedAt,
      );
      check(
        "snapshot keeps 400 tasks in descending order",
        limited.type === "snapshot" && tasks.length === 400 && descending,
        `tasks=${tasks.length} descending=${descending}`,
      );
    } finally {
      limitSocket.close();
    }

    busStore.setAgents(
      [{ id: "smoke-acp", kind: "acp", name: "Smoke ACP", available: true, enabled: true }],
      true,
    );
    const connectorEvent = await socketA.next(2_000);
    const connectors = connectorEvent.event?.snapshot?.agents?.[0]?.connectors;
    check(
      "connector change emits a full snapshot",
      connectorEvent.type === "event" &&
        connectorEvent.event?.kind === "snapshot" &&
        Array.isArray(connectors) &&
        connectors.length === 1,
      `kind=${String(connectorEvent.event?.kind)} connectors=${Array.isArray(connectors) ? connectors.length : "?"}`,
    );

    busStore.rememberProject({
      agentId: busStore.agentId() || "smoke-agent",
      path: "C:\\smoke-project",
      name: "smoke-project",
      lastUsedAt: new Date().toISOString(),
      pinned: false,
    });
    const projectEvent = await socketA.next(2_000);
    const projects = projectEvent.event?.snapshot?.projects;
    check(
      "project change emits a full snapshot",
      projectEvent.type === "event" &&
        projectEvent.event?.kind === "snapshot" &&
        Array.isArray(projects) &&
        projects.some((item: { path?: string }) => item.path === "C:\\smoke-project"),
      `kind=${String(projectEvent.event?.kind)} projects=${Array.isArray(projects) ? projects.length : "?"}`,
    );
    console.log(
      "SKIP  two separate pairing credentials (host Config supports one e2eeMasterKey)",
    );
  } finally {
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
