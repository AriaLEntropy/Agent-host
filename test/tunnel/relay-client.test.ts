import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { Config } from "../../src/config.js";
import { RelayClient, probeDsh } from "../../src/tunnel/relay-client.js";

async function listen(options: { reject?: boolean } = {}): Promise<{
  port: number;
  authCount: () => number;
  close: () => Promise<void>;
}> {
  const server = new WebSocketServer({ port: 0 });
  let current: import("ws").WebSocket | undefined;
  let authCount = 0;
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type?: string };
      if (msg.type !== "auth") return;
      authCount += 1;
      if (options.reject) {
        socket.close(4003, "auth failed");
        return;
      }
      current?.close(4002, "replaced");
      current = socket;
      socket.send(
        JSON.stringify({
          v: 1,
          type: "auth_ok",
          id: `auth-${authCount}`,
          ts: Date.now(),
          payload: {},
        }),
      );
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.once("listening", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  return {
    port,
    authCount: () => authCount,
    close: () =>
      new Promise((resolve) => {
        current?.terminate();
        server.close(() => resolve());
      }),
  };
}

function config(port: number): Config {
  return {
    hostName: "Test Mac",
    relay: `http://127.0.0.1:${port}`,
    dshPort: 1,
    hostId: "host_overlap",
    hostToken: "token_overlap",
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a second client for the same host stops the first instead of flapping", async () => {
  const relay = await listen();
  const first = new RelayClient(config(relay.port));
  const second = new RelayClient(config(relay.port));
  try {
    await first.start();
    await delay(150);
    assert.equal(relay.authCount(), 1);
    await second.start();
    await delay(200);
    assert.equal(first.status().connected, false);
    assert.equal(second.status().connected, true);
    assert.equal(relay.authCount(), 2);
    await delay(1500);
    assert.equal(relay.authCount(), 2);
  } finally {
    first.stop();
    second.stop();
    await relay.close();
  }
});

test("a rejected credential stops the client and is reported once", async () => {
  const relay = await listen({ reject: true });
  const rejections: string[] = [];
  const client = new RelayClient(config(relay.port), {
    probeDsh: async () => false,
    onAuthRejected: (detail) => rejections.push(detail),
  });
  try {
    await client.start();
    await delay(300);
    assert.equal(relay.authCount(), 1);
    assert.equal(client.status().connected, false);
    assert.deepEqual(rejections, ["auth failed"]);
    await delay(1200);
    assert.equal(relay.authCount(), 1, "a rejected credential must not retry");
  } finally {
    client.stop();
    await relay.close();
  }
});

test("dsh status follows the probe instead of being hard-coded online", async () => {
  let reachable = false;
  const client = new RelayClient(config(1), { probeDsh: async () => reachable });
  const probe = () => (client as unknown as { checkHealth: () => Promise<void> }).checkHealth();
  try {
    await probe();
    assert.equal(client.status().dsh, false, "no DSH web means offline");

    reachable = true;
    await probe();
    assert.equal(client.status().dsh, true, "a single good probe flips it online");

    reachable = false;
    await probe();
    await probe();
    assert.equal(client.status().dsh, true, "two failures are tolerated");
    await probe();
    assert.equal(client.status().dsh, false, "the third failure flips it offline");
  } finally {
    client.stop();
  }
});

test("a throwing probe never reports the DSH web as online", async () => {
  const client = new RelayClient(config(1), {
    probeDsh: async () => {
      throw new Error("boom");
    },
  });
  const probe = () => (client as unknown as { checkHealth: () => Promise<void> }).checkHealth();
  try {
    await probe();
    assert.equal(client.status().dsh, false);
  } finally {
    client.stop();
  }
});

test("probeDsh distinguishes a listening DSH web from a closed port", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("dsh");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  assert.equal(await probeDsh(port, 500), true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await probeDsh(port, 500), false);
});
