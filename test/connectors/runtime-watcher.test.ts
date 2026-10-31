import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type {
  AcpManifestChange,
  AcpManifestWatcherOptions,
} from "../../src/connectors/acp/manifest-watcher.js";
import {
  startConnectorWatcher,
  stopConnectorWatcher,
} from "../../src/connectors/runtime.js";

type FakeWatcher = {
  factory: (options: AcpManifestWatcherOptions) => { start(): Promise<void>; stop(): void };
  trigger(change: AcpManifestChange): void;
  starts: number;
  stops: number;
};

function fakeWatcher(): FakeWatcher {
  let options: AcpManifestWatcherOptions | undefined;
  const watcher: FakeWatcher = {
    starts: 0,
    stops: 0,
    factory(next) {
      options = next;
      return {
        async start() {
          watcher.starts += 1;
        },
        stop() {
          watcher.stops += 1;
        },
      };
    },
    trigger(change) {
      options?.onChange(change);
    },
  };
  return watcher;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(read: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!read()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await delay(5);
  }
}

const change: AcpManifestChange = { added: ["a.json"], changed: [], removed: [] };

beforeEach(() => {
  stopConnectorWatcher();
});

afterEach(() => {
  stopConnectorWatcher();
});

describe("connector manifest watcher wiring", { concurrency: false }, () => {
  test("start and stop are idempotent, and repeated start reuses the watcher", async () => {
    const fake = fakeWatcher();
    let refreshes = 0;
    const options = {
      createWatcher: fake.factory,
      refresh: async () => {
        refreshes += 1;
        return { agents: [] };
      },
      directory: "unused",
    };

    await startConnectorWatcher(options);
    await startConnectorWatcher(options);
    assert.equal(fake.starts, 1);

    fake.trigger(change);
    await until(() => refreshes === 1);

    stopConnectorWatcher();
    stopConnectorWatcher();
    assert.equal(fake.stops, 1);
  });

  test("changes during a running refresh are coalesced into exactly one more run", async () => {
    const fake = fakeWatcher();
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await startConnectorWatcher({
      createWatcher: fake.factory,
      directory: "unused",
      refresh: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return { agents: [{ id: "a" }], problems: [] };
      },
    });

    fake.trigger(change);
    fake.trigger(change);
    fake.trigger(change);
    await until(() => calls === 1);
    assert.equal(maxActive, 1);

    release();
    await until(() => calls === 2);
    await delay(20);
    assert.equal(calls, 2, "three changes collapse into one queued refresh");
    assert.equal(maxActive, 1, "refreshAgents never overlaps itself");
  });

  test("stop drops pending changes and prevents later callbacks from refreshing", async () => {
    const fake = fakeWatcher();
    let refreshes = 0;
    await startConnectorWatcher({
      createWatcher: fake.factory,
      directory: "unused",
      refresh: async () => {
        refreshes += 1;
        return { agents: [] };
      },
    });

    stopConnectorWatcher();
    fake.trigger(change);
    await delay(30);
    assert.equal(refreshes, 0);
  });

  test("a failing refresh is logged as a category and does not break later runs", async () => {
    const fake = fakeWatcher();
    let calls = 0;
    await startConnectorWatcher({
      createWatcher: fake.factory,
      directory: "unused",
      refresh: async () => {
        calls += 1;
        if (calls === 1) throw new Error("discovery failed");
        return { agents: [] };
      },
    });

    fake.trigger(change);
    await until(() => calls === 1);
    fake.trigger(change);
    await until(() => calls === 2);
  });
});
