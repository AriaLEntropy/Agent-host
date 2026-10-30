// Ported from botbus-protocol/Sources/BotBusConnectors/Claude/ClaudeLateAnswer.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import { ConnectorError } from "../ported/contract.js";
import type { ClaudePendingRequest } from "./claude-shared.js";
import { trimmed } from "./claude-shared.js";

/**
 * 送不到了的审批 / 提问：hook 被 Claude Code 掐掉或到了时限、手机那一轮超时已按拒绝回、
 * 进程已经退出。手机上照样点得到，回答改成一条续聊。
 */
export class ClaudeLateRequest {
  /** 操作内容只取第一行、最多这么多字。 */
  static readonly detailLimit = 200;

  readonly sessionID: string;
  /** 当时那张卡片。拼续聊只用它：审批看 summary / detail，提问看 questions。 */
  readonly request: ClaudePendingRequest;
  /** 电脑上的会话（hook）：发之前看 transcript；手机那一轮里为 null。 */
  readonly transcriptPath: string | null;
  readonly since: Date;

  constructor(sessionID: string, request: ClaudePendingRequest, transcriptPath: string | null, since: Date) {
    this.sessionID = sessionID;
    this.request = request;
    this.transcriptPath = transcriptPath;
    this.since = since;
  }

  /** 改发的续聊；拒绝 / 跳过返回 null（只收卡片）。提问一个都没选时报错，卡片留着。 */
  followUp(decision: "allow" | "deny", answers: Record<string, string[]> | null | undefined): string | null {
    if (decision !== "allow") return null;
    const questions = this.request.questions;
    if (!questions || questions.length === 0) return ClaudeLateRequest.approval(this.request);
    const text = ClaudeLateRequest.answers(questions, answers ?? {});
    if (text === null) throw new ConnectorError("没有收到选项，请先选好再提交");
    return text;
  }

  /** `已批准：Bash · npm test，请继续。` */
  static approval(request: ClaudePendingRequest): string {
    const lines = (request.detail ?? "")
      .split(/\r\n|[\r\n]/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return `已批准：${request.summary}，请继续。`;
    const first = lines[0];
    let detail = first.slice(0, ClaudeLateRequest.detailLimit);
    if (lines.length > 1 || first.length > ClaudeLateRequest.detailLimit) detail += "…";
    return `已批准：${request.summary} · ${detail}，请继续。`;
  }

  /**
   * 一题只发答案；多题按题目顺序一行一题「问题 答案」。多选用 `, ` 连。
   * 没选任何答案返回 null。
   */
  static answers(
    questions: Array<{ id: string; question: string }>,
    answers: Record<string, string[]>,
  ): string | null {
    const picked: Array<{ question: string; answer: string }> = [];
    for (const question of questions) {
      const values = (answers[question.id] ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (values.length === 0) continue;
      picked.push({ question: trimmed(question.question), answer: values.join(", ") });
    }
    if (picked.length === 0) return null;
    if (questions.length === 1) return picked[0].answer;
    return picked
      .map((item) => {
        // 问题自带问号、冒号的不再加冒号；半角的隔一个空格。
        let separator: string;
        if (item.question.endsWith("？") || item.question.endsWith("：")) separator = "";
        else if (item.question.endsWith("?") || item.question.endsWith(":")) separator = " ";
        else separator = "：";
        return item.question + separator + item.answer;
      })
      .join("\n");
  }
}
