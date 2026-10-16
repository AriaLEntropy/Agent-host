import assert from "node:assert/strict";
import test from "node:test";
import { reconnectDelayMs } from "../../src/tunnel/relay-client.js";

test("reconnect delay doubles up to 60 seconds and stays inside the jitter", () => {
  assert.equal(reconnectDelayMs(0, () => 0.5), 1000);
  assert.equal(reconnectDelayMs(1, () => 0.5), 2000);
  assert.equal(reconnectDelayMs(2, () => 0.5), 4000);
  assert.equal(reconnectDelayMs(6, () => 0), 30_000);
  assert.equal(reconnectDelayMs(6, () => 1), 90_000);
});
