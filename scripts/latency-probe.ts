import { createServer } from "node:http";
import {
  createChecks,
  createHarness,
  type Harness,
} from "./lib/sealed-harness.js";

const MESSAGE_COUNT = 200;
const MESSAGE_TEXT = "x".repeat(1000);
const LARGE_BYTES = 50 * 1024 * 1024;

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function summary(name: string, values: number[], bytes: number) {
  return `${name} p50=${percentile(values, 0.5).toFixed(1)}ms p95=${percentile(values, 0.95).toFixed(1)}ms max=${Math.max(...values).toFixed(1)}ms bytes=${bytes}`;
}

async function main() {
  const messages = Buffer.from(
    JSON.stringify({
      taskId: "latency:task",
      agentId: "latency-agent",
      messages: Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
        id: `m-${index}`,
        role: index % 2 === 0 ? "user" : "agent",
        text: MESSAGE_TEXT,
        createdAt: new Date().toISOString(),
      })),
      hasMore: false,
      fetchedAt: new Date().toISOString(),
    }),
  );
  const large = Buffer.alloc(LARGE_BYTES, 0x61);

  const server = createServer((request, response) => {
    if (request.url === "/messages") {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": messages.length,
      });
      response.end(messages);
      return;
    }
    if (request.url === "/large") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": large.length,
      });
      response.end(large);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not_found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const dshPort = typeof address === "object" && address ? address.port : 0;

  let harness: Harness | undefined;
  const { check, finish } = createChecks();
  try {
    harness = await createHarness({ hostName: "Latency Host", dshPort });
    const tunnel = harness.tunnel;

    for (let index = 0; index < 2; index += 1) {
      const response = await tunnel.request("GET", "/messages", undefined, 30_000);
      check(
        `200-message request #${index + 1}`,
        response.status === 200 && response.body.length === messages.length,
        `status=${response.status} bytes=${response.body.length}`,
      );
    }
    const messageTimes: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now();
      const response = await tunnel.request("GET", "/messages", undefined, 30_000);
      messageTimes.push(performance.now() - started);
      if (response.status !== 200) throw new Error(`messages returned ${response.status}`);
    }
    const messageBytes = messages.length;
    console.log(summary("200 messages", messageTimes, messageBytes));

    const largeTimes: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const started = performance.now();
      const response = await tunnel.request("GET", "/large", undefined, 60_000);
      largeTimes.push(performance.now() - started);
      check(
        `50 MiB response #${index + 1}`,
        response.status === 200 && response.body.length === LARGE_BYTES,
        `status=${response.status} bytes=${response.body.length}`,
      );
    }
    console.log(summary("50 MiB", largeTimes, LARGE_BYTES));

    const after = await tunnel.request("GET", "/messages", undefined, 30_000);
    check(
      "tunnel still usable after large response",
      after.status === 200,
      `status=${after.status}`,
    );
  } finally {
    await harness?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
