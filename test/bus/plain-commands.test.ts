import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptCommand,
  commandResultFor,
  setCommandLogPath,
  waitForCommands,
} from "../../src/bus/commands.js";
import { busStore } from "../../src/bus/store.js";
import { resetRuntime } from "../../src/connectors/runtime.js";

const agentId = "hV3nQ7pLxK2mR8sTfW4bZQ";
const fixtureDir = fileURLToPath(
  new URL("../contract/protocol-fixtures/plain", import.meta.url),
);

test("every plain command fixture decodes and produces a command result", async () => {
  const files = (await readdir(fixtureDir)).filter(
    (name) => name.startsWith("command-") && name.endsWith(".json"),
  );
  assert.ok(files.length >= 20, `expected at least 20 command fixtures, got ${files.length}`);

  for (const file of files) {
    setCommandLogPath(undefined);
    resetRuntime();
    busStore.reset();
    busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });

    const command = JSON.parse(await readFile(join(fixtureDir, file), "utf8")) as {
      id: string;
      kind: string;
    };
    const response = await acceptCommand(command);
    assert.equal(response.status, 202, `${file} was not accepted`);
    await waitForCommands();
    const result = commandResultFor(command.id);
    assert.ok(result, `${file} produced no result`);
    assert.equal(result.commandId, command.id, `${file} result has the wrong id`);
    assert.equal(typeof result.ok, "boolean", `${file} result has no ok flag`);
    assert.equal(typeof result.finishedAt, "string", `${file} result has no finishedAt`);
    if (!result.ok) assert.ok(result.error, `${file} failed without a reason`);
  }

  resetRuntime();
  setCommandLogPath(undefined);
  busStore.reset();
});
