import {
  acceptCommand,
  commandResultFor,
  flushCommandLog,
  loadCommandLog,
  setCommandLogPath,
} from "../../src/bus/commands.js";

const [logPath, id] = process.argv.slice(2);
if (!logPath || !id) {
  console.error("usage: command-restart-child.ts <commands.json> <id>");
  process.exit(2);
}

setCommandLogPath(logPath);
await loadCommandLog();
const before = commandResultFor(id);
const response = await acceptCommand({
  id,
  kind: "remoteControl",
  remoteControl: { taskId: "smoke-missing-task" },
});
await flushCommandLog();
const after = commandResultFor(id);
console.log(
  JSON.stringify({
    status: response.status,
    before: before?.finishedAt ?? null,
    after: after?.finishedAt ?? null,
  }),
);
