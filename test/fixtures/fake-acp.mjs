import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let sessionCount = 0;
let promptId = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.env.FAKE_ACP_EXIT === "1") process.exit(1);
    const version = process.env.FAKE_ACP_VERSION ? Number(process.env.FAKE_ACP_VERSION) : 1;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: version,
        agentCapabilities: { loadSession: true },
        promptCapabilities: { image: false },
      },
    });
    return;
  }
  if (message.method === "session/new") {
    sessionCount += 1;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: `sess-${sessionCount}` } });
    return;
  }
  if (message.method === "session/load" || message.method === "session/resume") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    const text = (message.params.prompt ?? []).map((block) => block.text ?? "").join("");
    if (text.includes("NEED_PERMISSION")) {
      send({
        jsonrpc: "2.0",
        id: 900,
        method: "session/request_permission",
        params: {
          sessionId: message.params.sessionId,
          toolCall: {
            toolCallId: "call_01",
            title: "npm test",
            kind: "execute",
            rawInput: { command: "npm test" },
          },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "deny", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已完成" } },
      },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.id === 900 && message.result) {
    const cancelled = message.result.outcome?.outcome === "cancelled";
    send({
      jsonrpc: "2.0",
      id: promptId,
      result: { stopReason: cancelled ? "cancelled" : "end_turn" },
    });
  }
});
