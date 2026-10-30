import { appendFileSync, readFileSync } from "node:fs";
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
        agentCapabilities: {
          loadSession: true,
          ...(process.env.FAKE_ACP_LIST === "1"
            ? { sessionCapabilities: { list: {} } }
            : {}),
        },
        promptCapabilities: { image: process.env.FAKE_ACP_IMAGE === "1" },
      },
    });
    return;
  }
  if (message.method === "session/list") {
    if (process.env.FAKE_ACP_LIST_CALLS) {
      try {
        appendFileSync(process.env.FAKE_ACP_LIST_CALLS, "x");
      } catch {
        // 计数文件写不了不影响协议行为。
      }
    }
    if (process.env.FAKE_ACP_LIST_ERROR === "1") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "list failed" } });
      return;
    }
    let result = { sessions: [] };
    const file = process.env.FAKE_ACP_LIST_FILE;
    if (file) {
      try {
        result = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        result = { sessions: [] };
      }
    }
    send({ jsonrpc: "2.0", id: message.id, result });
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
    const blocks = message.params.prompt ?? [];
    const text = blocks.map((block) => block.text ?? "").join("");
    const images = blocks.filter((block) => block.type === "image");
    if (text.includes("CRASH")) {
      process.stderr.write("fake crash\n");
      process.exit(1);
    }
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
    const reply =
      (text.startsWith("ECHO:") ? text.slice(5) : "已完成") +
      (images.length > 0
        ? `|images=${images.map((block) => `${block.mimeType}:${Buffer.from(block.data, "base64").length}`).join(",")}`
        : "");
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } },
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
