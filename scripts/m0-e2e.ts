import { fileURLToPath } from "node:url";
import { resetRuntime, useAgents } from "../src/connectors/runtime.js";
import { createChecks, createHarness, jsonBody } from "./lib/sealed-harness.js";

const fakeAcp = fileURLToPath(new URL("../test/fixtures/fake-acp.mjs", import.meta.url));

async function main() {
  const harness = await createHarness({ relayUrl: process.argv[2] });
  const { check, finish } = createChecks();

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

    const describe = await harness.tunnel.request("GET", "/bus/describe");
    const describeBody = jsonBody(describe);
    check(
      "GET /bus/describe",
      describe.status === 200 && describeBody.hostKind === "agent-host",
      `status=${describe.status} hostKind=${String(describeBody.hostKind)}`,
    );

    const commandId = `m0-e2e-${Date.now()}`;
    const posted = await harness.tunnel.request(
      "POST",
      "/bus/commands",
      Buffer.from(
        JSON.stringify({
          id: commandId,
          kind: "startTask",
          startTask: {
            source: "acp",
            connectorId: "fake",
            projectPath: process.cwd(),
            prompt: "ECHO:ok",
          },
        }),
      ),
    );
    check("POST /bus/commands", posted.status === 202, `status=${posted.status}`);

    let snapshot = jsonBody(await harness.tunnel.request("GET", "/bus/snapshot"));
    let result = snapshot.recentResults?.find(
      (item: Record<string, unknown>) => item.commandId === commandId,
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const task = snapshot.tasks?.find((item: Record<string, unknown>) =>
        String(item.id).startsWith("acp:fake:"),
      );
      if (result && task?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      snapshot = jsonBody(await harness.tunnel.request("GET", "/bus/snapshot"));
      result = snapshot.recentResults?.find(
        (item: Record<string, unknown>) => item.commandId === commandId,
      );
    }

    const task = snapshot.tasks?.find((item: Record<string, unknown>) =>
      String(item.id).startsWith("acp:fake:"),
    );
    check(
      "commandResult ok=true",
      result?.ok === true,
      `ok=${String(result?.ok)} error=${String(result?.error ?? "-")}`,
    );
    check("task completed", task?.status === "completed", `status=${String(task?.status)}`);
    check("snapshot seq>=1", Number(snapshot.seq) >= 1, `seq=${String(snapshot.seq)}`);
  } finally {
    resetRuntime();
    await harness.close();
  }

  finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
