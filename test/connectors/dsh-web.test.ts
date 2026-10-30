import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  browserSessionSecret,
  cookieHeader,
  cookieName,
  cookieValue,
} from "../../src/connectors/dsh/auth.js";
import {
  DshWebClient,
  cursorFromPastCursorMessage,
  eventFromJson,
  eventText,
  summaryFromJson,
} from "../../src/connectors/dsh/web.js";

const syntheticSecret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const secretBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index));

function yaml(secret = syntheticSecret, key = "client-connection/browser-session") {
  return [
    "version: 1",
    "records:",
    `  ${key}:`,
    "    kind: grant",
    "    payload:",
    "      version: 1",
    `      secret: ${secret}`,
    "refs:",
    "  DEEPSEEK_API_KEY: sk-not-a-real-key",
  ].join("\n");
}

describe("dsh web auth", () => {
  test("reads the browser-session secret and ignores other records", () => {
    assert.deepEqual(browserSessionSecret(yaml()), secretBytes);
    assert.equal(browserSessionSecret(yaml(syntheticSecret, "something/else")), null);
    assert.equal(browserSessionSecret(yaml(`${syntheticSecret}=`)), null);
  });

  test("matches the node cookie vector", () => {
    const secret = browserSessionSecret(yaml());
    assert.ok(secret);
    assert.equal(cookieName("127.0.0.1:3181"), "dsh-auth-D1gu4AUZ6XwohD5r0eN4-fmFNLAOCeA62Dj465JieJs");
    assert.equal(
      cookieValue(secret, "127.0.0.1:3181", 1_790_000_000_000, 1_790_003_600_000),
      "v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6MzE4MSIsImlzc3VlZEF0IjoxNzkwMDAwMDAwMDAwLCJleHBpcmVzQXQiOjE3OTAwMDM2MDAwMDB9.DFxOWiL0d2udvGmnOuXL5CscTtqypVgodxy-pwjzwWU",
    );
  });

  test("issues the cookie slightly in the past", () => {
    const secret = browserSessionSecret(yaml());
    assert.ok(secret);
    const header = cookieHeader(secret, "127.0.0.1:3181", 1_790_000_005_000);
    assert.equal(
      header,
      "dsh-auth-D1gu4AUZ6XwohD5r0eN4-fmFNLAOCeA62Dj465JieJs=" +
        cookieValue(secret, "127.0.0.1:3181", 1_790_000_000_000, 1_790_003_600_000),
    );
  });
});

describe("dsh web client", () => {
  test("session/list uses _request and maps summaries", async () => {
    let body: any;
    const client = new DshWebClient({
      port: 3181,
      secret: secretBytes,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init.body));
        return jsonResponse({
          type: "server-response",
          rpcId: body.rpcId,
          result: {
            ok: true,
            value: {
              items: [
                {
                  sessionId: "s1",
                  updatedAt: 1_790_000_000_000,
                  running: true,
                  blank: false,
                  cwd: "E:/work/demo",
                  projections: { asOfSeq: 42, values: { title: "Fix login" } },
                },
              ],
            },
          },
        });
      },
    });
    const sessions = await client.listSessions();
    assert.equal(body.method, "session/list");
    assert.deepEqual(body.payload.args, { _request: {} });
    assert.equal(sessions[0]?.sessionId, "s1");
    assert.equal(sessions[0]?.title, "Fix login");
    assert.equal(sessions[0]?.updatedAt?.toISOString(), new Date(1_790_000_000_000).toISOString());
  });

  test("latestPage reads the cursor from past cursor and retries", async () => {
    const seen: any[] = [];
    const client = new DshWebClient({
      port: 3181,
      secret: secretBytes,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        seen.push(body.payload.args.request);
        if (seen.length === 1) {
          return jsonResponse({
            result: {
              ok: false,
              error: { code: "gateway/bad-request", message: "session page through seq 9007199254740991 is past cursor 120" },
            },
          });
        }
        return jsonResponse({
          result: {
            ok: true,
            value: {
              records: [
                { type: "event", event: { type: "user/message", seq: 120, time: 1_790_000_000_000, data: { content: [{ type: "text", text: "hi" }] } } },
              ],
              hasMore: false,
            },
          },
        });
      },
    });
    const page = await client.latestPage("s1", 50);
    assert.equal(seen[0].throughSeq, Number.MAX_SAFE_INTEGER);
    assert.equal(seen[1].throughSeq, 120);
    assert.equal(page.events[0]?.type, "user/message");
    assert.equal(eventText(page.events[0]!), "hi");
  });

  test("session/prompt sends requestId and queue mode", async () => {
    let args: any;
    const client = new DshWebClient({
      port: 3181,
      secret: secretBytes,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        args = body.payload.args.request;
        return jsonResponse({ result: { ok: true, value: { accepted: true } } });
      },
    });
    assert.equal(await client.prompt("s1", "hello", "cmd-1"), true);
    assert.deepEqual(args, {
      requestId: "cmd-1",
      sessionId: "s1",
      mode: "queue",
      content: [{ type: "text", text: "hello" }],
    });
  });

  test("parses the event envelope and ignores session headers", () => {
    const event = eventFromJson({
      type: "event",
      event: { type: "assistant/message", seq: 7, data: { message: { content: [{ type: "text", text: "done" }] } } },
    });
    assert.equal(event?.seq, 7);
    assert.equal(eventText(event!), "done");
    assert.equal(eventFromJson({ type: "session", id: "s1" }), null);
    assert.equal(cursorFromPastCursorMessage("past cursor -1"), -1);
  });

  test("summary ignores incomplete rows", () => {
    assert.equal(summaryFromJson({ cwd: "x" }), null);
    assert.equal(summaryFromJson({ sessionId: "s1", cwd: "" })?.cwd, undefined);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify({ type: "server-response", ...(body as object) }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
