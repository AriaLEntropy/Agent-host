import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { busStore, type BusEvent, type BusTask } from "../../src/bus/store.js";
import { NOTIFY_BODY_LIMIT, notifyForTaskChange } from "../../src/bus/notify.js";

function task(overrides: Partial<BusTask> = {}): BusTask {
  return {
    id: "codex:thread-1",
    agentId: "hV3nQ7pLxK2mR8sTfW4bZQ",
    source: "codex",
    title: "修登录页",
    projectPath: "C:/work/demo",
    projectName: "demo",
    status: "running",
    origin: "desktop",
    controllable: true,
    startedAt: "2026-11-05T00:00:00Z",
    updatedAt: "2026-11-05T00:00:01Z",
    ...overrides,
  };
}

describe("notifyForTaskChange", () => {
  test("a task seen for the first time is a baseline, not a change", () => {
    assert.equal(notifyForTaskChange(undefined, task({ status: "completed" }), "工作台"), null);
  });

  test("a pending command becomes TASK_APPROVAL with its requestId", () => {
    const previous = task();
    const next = task({
      status: "waitingApproval",
      pendingRequest: { id: "req-7", kind: "command", summary: "rm -rf dist" },
    });

    const notify = notifyForTaskChange(previous, next, "工作台");
    assert.equal(notify?.category, "TASK_APPROVAL");
    assert.equal(notify?.requestId, "req-7");
    assert.equal(notify?.title, "修登录页 需要审批");
    assert.equal(notify?.body, "rm -rf dist");
    assert.equal(notify?.agentName, "工作台");
    assert.equal(notify?.taskId, "codex:thread-1");
  });

  test("the same pending request is not announced twice", () => {
    const withRequest = task({
      status: "waitingApproval",
      pendingRequest: { id: "req-7", kind: "command", summary: "rm -rf dist" },
    });

    assert.equal(notifyForTaskChange(withRequest, withRequest, "工作台"), null);
  });

  test("an input request becomes TASK_INPUT and omits requestId entirely", () => {
    const next = task({
      status: "waitingInput",
      pendingRequest: {
        id: "req-8",
        kind: "input",
        summary: "在等你回答",
        questions: [{ id: "q1", question: "README 要不要写 Homebrew 的安装方式？" }],
      },
    });

    const notify = notifyForTaskChange(task(), next, "工作台");
    assert.equal(notify?.category, "TASK_INPUT");
    assert.equal("requestId" in (notify ?? {}), false);
    assert.equal(notify?.body, "README 要不要写 Homebrew 的安装方式？");
    assert.equal(notify?.title, "修登录页 在等你回复");
  });

  test("running turns into done and failure are both announced", () => {
    const done = notifyForTaskChange(task(), task({ status: "completed", lastMessage: "改好了" }), "工作台");
    assert.equal(done?.category, "TASK_DONE");
    assert.equal(done?.body, "改好了");

    const failed = notifyForTaskChange(
      task({ status: "waitingApproval" }),
      task({ status: "failed", lastMessage: "API Error: 500" }),
      "工作台",
    );
    assert.equal(failed?.category, "TASK_FAILED");
    assert.equal(failed?.body, "API Error: 500");
  });

  test("a terminal state reached from a terminal state stays quiet", () => {
    // 翻历史、重启后的对账会给出 completed→completed、interrupted→completed 这类形状，
    // 它们不是「刚刚发生的变化」
    assert.equal(notifyForTaskChange(task({ status: "interrupted" }), task({ status: "completed" }), "工作台"), null);
    assert.equal(notifyForTaskChange(task({ status: "completed" }), task({ status: "completed" }), "工作台"), null);
  });

  test("interrupted and idle are not categories", () => {
    assert.equal(notifyForTaskChange(task(), task({ status: "interrupted" }), "工作台"), null);
    assert.equal(notifyForTaskChange(task(), task({ status: "idle" }), "工作台"), null);
  });

  test("the subject falls back to project name and then to the source", () => {
    assert.equal(
      notifyForTaskChange(task(), task({ title: "  ", status: "completed" }), "工作台")?.title,
      "demo 已完成",
    );
    assert.equal(
      notifyForTaskChange(
        task(),
        task({ title: "", projectName: "", status: "completed" }),
        "工作台",
      )?.title,
      "codex 会话 已完成",
    );
  });

  test("bodies fall back to a sentence when there is nothing to show", () => {
    assert.equal(notifyForTaskChange(task(), task({ status: "completed" }), "工作台")?.body, "任务已完成");
    assert.equal(notifyForTaskChange(task(), task({ status: "failed" }), "工作台")?.body, "任务失败");
    assert.equal(
      notifyForTaskChange(
        task(),
        task({ pendingRequest: { id: "req-9", kind: "permission", summary: "  " } }),
        "工作台",
      )?.body,
      "电脑上有一个请求在等你处理",
    );
  });

  test("a finished task hands over one sentence, not the whole reply", () => {
    const reply = "价格表已经加好了。LessonPlayer 的三处文案也顺手改了，都在这次的 diff 里。";
    const notify = notifyForTaskChange(task(), task({ status: "completed", lastMessage: reply }), "工作台");

    // 通知里只能放两三行，取第一句比从中间砍一刀更像人话
    assert.equal(notify?.body, "价格表已经加好了");
  });

  test("an error line with no sentence break is still cut to the limit", () => {
    const notify = notifyForTaskChange(
      task(),
      task({ status: "failed", lastMessage: "x".repeat(NOTIFY_BODY_LIMIT + 40) }),
      "工作台",
    );

    assert.equal(Array.from(notify?.body ?? "").length, NOTIFY_BODY_LIMIT + 1);
    assert.equal((notify?.body ?? "").endsWith("…"), true);
  });

  test("a long question keeps its question mark", () => {
    const question = `README 里要不要补一段用 Homebrew 安装的方式？${"另外顺手说一下版本要求。".repeat(6)}`;
    const notify = notifyForTaskChange(
      task(),
      task({
        status: "waitingInput",
        pendingRequest: {
          id: "req-11",
          kind: "input",
          summary: "在等你回答",
          questions: [{ id: "q1", question }],
        },
      }),
      "工作台",
    );

    // 提问正文不按句子切：切成半句会把问号丢掉
    assert.equal((notify?.body ?? "").startsWith("README 里要不要补一段用 Homebrew 安装的方式？"), true);
    assert.equal(Array.from(notify?.body ?? "").length, NOTIFY_BODY_LIMIT + 1);
  });

  test("long bodies are cut by code point, not by UTF-16 unit", () => {
    const wide = "🙂".repeat(NOTIFY_BODY_LIMIT + 50);
    const body = notifyForTaskChange(task(), task({ status: "completed", lastMessage: wide }), "工作台")?.body ?? "";

    // 每个 emoji 是 2 个 UTF-16 单元；按码点截才刚好是上限个字符再加省略号
    assert.equal(Array.from(body).length, NOTIFY_BODY_LIMIT + 1);
    assert.equal(body.endsWith("…"), true);
  });
});

describe("TaskStore emits notify alongside taskUpdated", () => {
  let events: BusEvent[];
  let unsubscribe: (() => boolean) | undefined;

  beforeEach(() => {
    busStore.reset();
    busStore.identify({
      agentId: "hV3nQ7pLxK2mR8sTfW4bZQ",
      hostName: "工作台",
      hostVersion: "1.0.0",
      platform: "windows",
    });
    events = [];
    unsubscribe = busStore.subscribe((event) => events.push(event));
  });

  afterEach(() => {
    unsubscribe?.();
    busStore.reset();
  });

  test("a status change sends one notify frame and does not advance seq", () => {
    busStore.upsertTask(task());
    const beforeSeq = busStore.currentSeq();

    busStore.upsertTask(task({ status: "completed", lastMessage: "改好了" }));

    const notifies = events.filter((event) => event.kind === "notify");
    assert.equal(notifies.length, 1);
    assert.equal(notifies[0]?.notify?.category, "TASK_DONE");
    assert.equal(notifies[0]?.notify?.agentName, "工作台");
    assert.equal(busStore.currentSeq(), beforeSeq + 1, "taskUpdated 仍然推进版本");
  });

  test("a silent baseline upsert sends nothing", () => {
    busStore.upsertTask(task({ status: "completed" }), false);

    assert.deepEqual(events, []);
    assert.equal(busStore.currentSeq(), 0);
  });

  test("the first sighting of an existing task never notifies", () => {
    busStore.upsertTask(task({ status: "completed", lastMessage: "早就做完了" }));

    // 第一条是基线（previous 不存在），第二条例外的重复 upsert 状态没变
    busStore.upsertTask(task({ status: "completed", lastMessage: "早就做完了" }));
    assert.equal(events.filter((event) => event.kind === "notify").length, 0);
  });
});
