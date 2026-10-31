import { appendFileSync, readFileSync } from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let sessionCount = 0;
let promptId = 0;
let promptSessionId = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.env.FAKE_ACP_EXIT === "1") process.exit(1);
    if (process.env.FAKE_ACP_INIT_CALLS) {
      try {
        appendFileSync(process.env.FAKE_ACP_INIT_CALLS, "x");
      } catch {
        // 计数文件写不了不影响协议行为。
      }
    }
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
    if (process.env.FAKE_ACP_EXIT_AFTER_LIST === "1") {
      // 让进程在对账结束后自然退出：用来验证"没在跑的 agent 不按短周期反复拉起"。
      setTimeout(() => process.exit(0), 10);
    }
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
    promptSessionId = message.params.sessionId;
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
    if (text.includes("NEED_SCOPE")) {
      send({
        jsonrpc: "2.0",
        id: 901,
        method: "session/request_permission",
        params: {
          sessionId: message.params.sessionId,
          toolCall: {
            toolCallId: "call_scope",
            title: "保存文件",
            kind: "edit",
            rawInput: { path: "a.txt" },
          },
          options: [
            { optionId: "allow-once", name: "仅此一次", kind: "allow_once" },
            { optionId: "allow-always", name: "始终允许", kind: "allow_always" },
            { optionId: "deny", name: "拒绝", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    if (text.startsWith("ECHO_SELF:")) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
        },
      });
    }
    if (text.includes("TOOL_UPDATE")) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_tool",
            title: "npm test",
            kind: "execute",
            rawInput: { command: "npm test" },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_tool",
            content: [{ type: "content", content: { type: "text", text: "PASS" } }],
          },
        },
      });
    }
    if (text.includes("IMAGE_REPLY")) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "生成了一张图" },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "image",
              // 1×1 PNG
              data:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
              mimeType: "image/png",
            },
          },
        },
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (text.includes("MAX_TOKENS")) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "partial" },
          },
        },
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "max_tokens" } });
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
  if ((message.id === 900 || message.id === 901) && message.result) {
    const cancelled = message.result.outcome?.outcome === "cancelled";
    const selected = message.result.outcome?.optionId;
    if (!cancelled) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: promptSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `approved:${selected}` },
          },
        },
      });
    }
    send({
      jsonrpc: "2.0",
      id: promptId,
      result: { stopReason: cancelled ? "cancelled" : "end_turn" },
    });
  }
});
