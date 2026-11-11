import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import {
  createPairingTicket,
  PairingExpiredError,
} from "../../src/tunnel/pairing.js";
import { generateMasterKey } from "../../src/tunnel/e2ee.js";

// 配对成功会 saveConfig 落盘；测试绝不能碰真实 %APPDATA%\agent-host\config.json
process.env.AGENT_HOST_CONFIG =
  process.env.AGENT_HOST_CONFIG ??
  join(tmpdir(), `agent-host-pairing-test-${randomUUID()}.json`);

type FakeRelay = {
  url: string;
  waitCount: () => number;
  confirmCount: () => number;
  claim: () => Promise<void>;
  close: () => Promise<void>;
};

async function fakeRelay(mode: "push" | "legacy"): Promise<FakeRelay> {
  let claimed = false;
  let waitCount = 0;
  let confirmCount = 0;
  const holders: import("node:http").ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const send = (status: number, data: unknown) => {
        const payload = JSON.stringify(data);
        res.writeHead(status, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
      };
      if (req.url === "/pair/session") {
        return send(201, {
          pairId: "pair_test",
          confirmSecret: "secret",
          expiresAt: Date.now() + 60_000,
        });
      }
      if (req.url === "/pair/wait") {
        waitCount += 1;
        if (mode === "legacy") return send(404, { error: "not_found" });
        if (claimed) return send(200, { status: "claimed" });
        holders.push(res);
        res.once("close", () => {
          const index = holders.indexOf(res);
          if (index >= 0) holders.splice(index, 1);
        });
        return;
      }
      if (req.url === "/pair/confirm") {
        confirmCount += 1;
        if (!claimed) return send(202, { status: "pending" });
        return send(200, { hostId: "host_test", hostToken: "token_test" });
      }
      return send(404, { error: "not_found" });
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.once("listening", () => {
      resolve((server.address() as AddressInfo).port);
    });
    server.listen(0, "127.0.0.1");
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    waitCount: () => waitCount,
    confirmCount: () => confirmCount,
    claim: async () => {
      claimed = true;
      for (const res of holders.splice(0)) {
        const payload = JSON.stringify({ status: "claimed" });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
      }
    },
    close: () =>
      new Promise((resolve) => {
        for (const res of holders.splice(0)) res.destroy();
        server.close(() => resolve());
      }),
  };
}

async function until(predicate: () => boolean, timeoutMs = 5000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function configFor(relay: string): Config {
  return { hostName: "Pairing Test", relay, publicRelayUrl: relay, dshPort: 3080 };
}

test("push pairing: one held wait, one confirm, no 2s polling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-pairing-push-"));
  process.env.AGENT_HOST_CONFIG = join(dir, "config.json");
  const relay = await fakeRelay("push");
  try {
    const ticket = await createPairingTicket(configFor(relay.url));
    const waiting = ticket.waitForConfirmation();
    await until(() => relay.waitCount() >= 1);
    await relay.claim();
    const next = await waiting;
    assert.equal(next.hostId, "host_test");
    assert.equal(next.hostToken, "token_test");
    assert.ok(next.e2eeMasterKey);
    assert.equal(relay.waitCount(), 1);
    assert.equal(relay.confirmCount(), 1);
    const saved = JSON.parse(
      await readFile(process.env.AGENT_HOST_CONFIG!, "utf8"),
    );
    assert.equal(saved.hostToken, "token_test");
  } finally {
    await relay.close();
  }
});

test("cancel aborts the held wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-pairing-cancel-"));
  process.env.AGENT_HOST_CONFIG = join(dir, "config.json");
  const relay = await fakeRelay("push");
  try {
    const ticket = await createPairingTicket(configFor(relay.url));
    const waiting = ticket.waitForConfirmation();
    await until(() => relay.waitCount() >= 1);
    ticket.cancel();
    await assert.rejects(waiting, PairingExpiredError);
  } finally {
    await relay.close();
  }
});

test("relay without /pair/wait falls back to confirm polling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-pairing-legacy-"));
  process.env.AGENT_HOST_CONFIG = join(dir, "config.json");
  const relay = await fakeRelay("legacy");
  try {
    const ticket = await createPairingTicket(configFor(relay.url));
    const waiting = ticket.waitForConfirmation();
    await until(() => relay.confirmCount() >= 1);
    await relay.claim();
    const next = await waiting;
    assert.equal(next.hostToken, "token_test");
    assert.equal(relay.waitCount(), 1);
    assert.ok(relay.confirmCount() >= 2);
  } finally {
    await relay.close();
  }
});

test("add-device pairing reuses host identity and never saves a new config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-pairing-add-"));
  process.env.AGENT_HOST_CONFIG = join(dir, "config.json");
  const masterKey = generateMasterKey();
  let seenAuth = "";
  let seenBody: Record<string, any> = {};
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const send = (status: number, data: unknown) => {
        const payload = JSON.stringify(data);
        res.writeHead(status, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
      };
      if (req.url === "/pair/device-session") {
        seenAuth = String(req.headers.authorization ?? "");
        seenBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        return send(201, {
          pairId: "pair_add",
          confirmSecret: "secret",
          expiresAt: Date.now() + 60_000,
        });
      }
      if (req.url === "/pair/wait") return send(200, { status: "claimed" });
      if (req.url === "/pair/confirm")
        return send(200, {
          hostId: "host_existing",
          hostToken: null,
          added: true,
        });
      return send(404, { error: "not_found" });
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.once("listening", () => resolve((server.address() as AddressInfo).port));
    server.listen(0, "127.0.0.1");
  });
  try {
    const config: Config = {
      ...configFor(`http://127.0.0.1:${port}`),
      hostId: "host_existing",
      hostToken: "token_existing",
      e2eeMasterKey: masterKey,
    };
    const ticket = await createPairingTicket(config, { addDevice: true });
    assert.equal(ticket.addDevice, true);
    assert.match(ticket.link, /key=/);
    assert.equal(seenAuth, "Host token_existing");
    assert.equal(seenBody.hostId, "host_existing");
    assert.equal(typeof seenBody.claimTokenHash, "string");
    const next = await ticket.waitForConfirmation();
    assert.equal(next.hostId, "host_existing");
    assert.equal(next.hostToken, "token_existing");
    assert.equal(next.e2eeMasterKey, masterKey);
    await assert.rejects(readFile(process.env.AGENT_HOST_CONFIG!, "utf8"), /ENOENT/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});