// Ported from botbus-protocol/Sources/BotBusConnectors/Claude/ClaudeFailure.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import type { ClaudeFailureDiagnosis } from "./claude-shared.js";

/**
 * Claude Code 失败时的原话 → 协议 3.7 的诊断。只认见过的原话，认不出给 null。
 *
 * **只喂错误原文**（StopFailure 的 `error_details`、报错的 `result` 行），
 * 不喂 agent 自己说的话。
 */
export const ClaudeFailure = {
  notSignedInMarkers: ["not logged in", "please run /login", "invalid api key"],
  /** 先于上一组比：失效的提示里也可能带 `Please run /login`。 */
  expiredMarkers: [
    "oauth token has expired",
    "oauth access token has been revoked",
    "authentication_error",
    "failed to authenticate",
  ],
  usageLimitMarkers: ["usage limit reached", "hit your limit", "rate_limit_error"],

  /**
   * `StopFailure` hook：先看结构化的类别（`error`）——限流、账单 → 额度，
   * 鉴权失败再按详情分失效还是没登录；没有类别才看错误原文（`error_details`）。
   */
  diagnosisFromCategory(category: string | null | undefined, details: string | null | undefined): ClaudeFailureDiagnosis | null {
    const normalized = (category ?? "").trim().toLowerCase();
    if (normalized.length === 0) return ClaudeFailure.diagnosis(details);
    switch (normalized) {
      case "rate_limit":
      case "billing_error":
        return usageLimit(ClaudeFailure.resetTime(details));
      case "authentication_failed":
        return signIn(details) ?? { kind: "notSignedIn" };
      default:
        return null;
    }
  },

  diagnosis(text: string | null | undefined): ClaudeFailureDiagnosis | null {
    if (!text || text.length === 0) return null;
    const signedIn = signIn(text);
    if (signedIn) return signedIn;
    const lowered = text.toLowerCase();
    if (
      ClaudeFailure.usageLimitMarkers.some((marker) => lowered.includes(marker)) ||
      (lowered.includes("limit reached") && lowered.includes("resets"))
    ) {
      return usageLimit(ClaudeFailure.resetTime(text));
    }
    return null;
  },

  /** `Claude AI usage limit reached|1791043200`：竖线后面是恢复时间的 Unix 秒。 */
  resetTime(text: string | null | undefined): string | null {
    if (!text) return null;
    const bar = text.lastIndexOf("|");
    if (bar < 0) return null;
    const rest = text.slice(bar + 1);
    const match = /^\d+/.exec(rest);
    if (!match || match[0].length < 9) return null;
    const seconds = Number(match[0]);
    if (!Number.isFinite(seconds)) return null;
    return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  },
};

function signIn(text: string | null | undefined): ClaudeFailureDiagnosis | null {
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (lowered.length === 0) return null;
  if (ClaudeFailure.expiredMarkers.some((marker) => lowered.includes(marker))) {
    return { kind: "signInExpired" };
  }
  if (ClaudeFailure.notSignedInMarkers.some((marker) => lowered.includes(marker))) {
    return { kind: "notSignedIn" };
  }
  return null;
}

function usageLimit(resetsAt: string | null): ClaudeFailureDiagnosis {
  return resetsAt ? { kind: "usageLimit", resetsAt } : { kind: "usageLimit" };
}
