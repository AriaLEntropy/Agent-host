import { dshPaths } from "../src/connectors/dsh/paths.js";
import { loadBrowserSessionSecret } from "../src/connectors/dsh/auth.js";
import {
  DshWebClient,
  DshWebError,
  eventSourceKind,
  eventText,
  eventTitle,
} from "../src/connectors/dsh/web.js";

const port = Number(process.argv[2] ?? process.env.DSH_PORT ?? 3080);
const paths = dshPaths();
const secret = await loadBrowserSessionSecret(paths);

if (!secret) {
  console.error(`读不到 DSH 的浏览器会话密钥：${paths.credentialsFile}`);
  process.exit(1);
}

const client = new DshWebClient({ port, secret });

try {
  const sessions = await client.listSessions();
  console.log(`DSH web 127.0.0.1:${port}，会话 ${sessions.length} 条`);
  for (const session of sessions.slice(0, 20)) {
    console.log(
      [
        session.sessionId,
        session.updatedAt?.toISOString() ?? "-",
        session.running ? "running" : session.blank ? "blank" : "idle",
        session.title ?? "-",
        session.cwd ?? "-",
      ].join(" | "),
    );
  }

  const target = sessions.find((session) => !session.blank);
  if (target) {
    const page = await client.latestPage(target.sessionId, 50);
    console.log(`\n最近一页：${target.sessionId}，${page.events.length} 条事件，hasMore=${page.hasMore}`);
    for (const event of page.events.slice(-20)) {
      const text = eventText(event);
      if (event.type === "session/title") console.log(`[title] ${eventTitle(event) ?? ""}`);
      else if (text) console.log(`[${event.type}${eventSourceKind(event) ? `/${eventSourceKind(event)}` : ""}] ${text.slice(0, 200)}`);
      else if (event.type === "tool/call" || event.type === "tool/result") console.log(`[${event.type}] seq=${event.seq}`);
    }
  }
} catch (error) {
  if (error instanceof DshWebError && error.status === 404) {
    console.error(
      "DSH web 没有 /api/session/list。当前实例可能是 0.1.1；参考连接器基线是 0.1.5-rc.3，先换到新版 dsh web 再跑。",
    );
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
