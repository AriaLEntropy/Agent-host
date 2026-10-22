import { MAX_UPLOAD_BYTES, PROTOCOL_VERSION, SNAPSHOT_LONG_POLL_MS } from "../src/bus/router.js";
import {
  createChecks,
  createHarness,
  jsonBody,
} from "./lib/sealed-harness.js";

const SKIP_LONG_POLL = process.env.SMOKE_SKIP_LONG_POLL === "1";

async function main() {
  const harness = await createHarness({ relayUrl: process.argv[2] });
  const tunnel = harness.tunnel;
  const { check, finish } = createChecks();

  try {
    const describe = await tunnel.request("GET", "/bus/describe");
    const describeBody = jsonBody(describe);
    check(
      "GET /bus/describe",
      describe.status === 200 &&
        describeBody.hostKind === "agent-host" &&
        describeBody.protocolVersion === PROTOCOL_VERSION,
      `status=${describe.status} hostKind=${String(describeBody.hostKind)} protocolVersion=${String(describeBody.protocolVersion)}`,
    );

    const snapshot = await tunnel.request("GET", "/bus/snapshot");
    const snapshotBody = jsonBody(snapshot);
    const agents = Array.isArray(snapshotBody.agents) ? snapshotBody.agents : [];
    const seq = typeof snapshotBody.seq === "number" ? snapshotBody.seq : -1;
    check(
      "GET /bus/snapshot",
      snapshot.status === 200 &&
        agents.length === 1 &&
        agents[0]?.online === true &&
        Array.isArray(snapshotBody.tasks),
      `status=${snapshot.status} agents=${agents.length} online=${String(agents[0]?.online)} tasks=${Array.isArray(snapshotBody.tasks) ? snapshotBody.tasks.length : "?"} seq=${seq}`,
    );

    const upload = await tunnel.request(
      "PUT",
      "/bus/uploads/smoke",
      Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x78),
    );
    check(
      `PUT /bus/uploads (${MAX_UPLOAD_BYTES + 1} bytes)`,
      upload.status === 413,
      `status=${upload.status} body=${upload.body.toString("utf8").slice(0, 80)}`,
    );

    const artifact = await tunnel.request("GET", "/bus/artifacts/missing");
    check(
      "GET /bus/artifacts/missing",
      artifact.status === 404,
      `status=${artifact.status} body=${artifact.body.toString("utf8").slice(0, 80)}`,
    );

    const unknown = await tunnel.request("GET", "/bus/not-a-route");
    check(
      "GET /bus/not-a-route",
      unknown.status === 404,
      `status=${unknown.status} body=${unknown.body.toString("utf8").slice(0, 80)}`,
    );

    const after = await tunnel.request("GET", "/bus/describe");
    check(
      "host still answers after unknown path",
      after.status === 200,
      `status=${after.status}`,
    );

    if (SKIP_LONG_POLL) {
      console.log(`SKIP  GET /bus/snapshot?since=${seq} (SMOKE_SKIP_LONG_POLL=1)`);
    } else {
      console.log(`WAIT  GET /bus/snapshot?since=${seq} (long poll, up to ${SNAPSHOT_LONG_POLL_MS}ms)`);
      const unchanged = await tunnel.request(
        "GET",
        `/bus/snapshot?since=${seq}`,
        undefined,
        SNAPSHOT_LONG_POLL_MS + 5_000,
      );
      check(
        `GET /bus/snapshot?since=${seq}`,
        unchanged.status === 304,
        `status=${unchanged.status}`,
      );
    }
  } finally {
    await harness.close();
  }

  finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
