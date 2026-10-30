// Ported from botbus-protocol/Sources/BotBusConnectors/Claude/ClaudeSessionPresence.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { recordValue } from "./claude-shared.js";

/**
 * 电脑上删掉、归档的 Claude 会话：连接器定期核对时看的两样东西（都只读）。
 *
 * - transcript：`~/.claude/projects/<目录>/<sessionId>.jsonl` 还在不在。
 * - 桌面 App 的会话记录：`claude-code-sessions/<org>/<account>/local_<uuid>.json`。
 *
 * 读不了一律回 null：不知道不等于没了，连接器那边这一轮就不摘。
 */
export const ClaudeSessionPresence = {
  /** `projects` 下一层目录里所有 transcript 的 session id。 */
  transcriptIDs(projectsDirectory: string): Set<string> | null {
    let directories: string[];
    try {
      directories = readdirSync(projectsDirectory);
    } catch {
      return null;
    }
    const ids = new Set<string>();
    for (const name of directories) {
      const directory = join(projectsDirectory, name);
      if (!isDirectoryEntry(directory)) continue;
      let files: string[];
      try {
        files = readdirSync(directory);
      } catch {
        return null;
      }
      for (const file of files) {
        if (file.endsWith(".jsonl")) ids.add(file.slice(0, -".jsonl".length));
      }
    }
    return ids;
  },
};

export type ClaudeDesktopRecord = {
  stamp: string;
  sessionID: string | null;
  isArchived: boolean;
};

export type ClaudeDesktopSessionIndex = {
  /** 有记录的会话 → 记录所在的账号目录。 */
  recorded: Map<string, string>;
  /** 侧栏里归档了的会话。 */
  archived: Set<string>;
  /** 这一次读到的账号目录。 */
  accounts: Set<string>;
};

export const ClaudeDesktopSessionIndex = {
  recordPrefix: "local_",

  /**
   * 读所有根目录。根目录不存在算没装桌面 App（不是错）；存在却读不了、
   * 某份记录解析不了（正在写）都回 null。
   *
   * @param cache 上一次的缓存；返回时换成这一次的（只留还在的记录）。
   */
  read(roots: string[], cache: Map<string, ClaudeDesktopRecord>): ClaudeDesktopSessionIndex | null {
    const index: ClaudeDesktopSessionIndex = {
      recorded: new Map(),
      archived: new Set(),
      accounts: new Set(),
    };
    const fresh = new Map<string, ClaudeDesktopRecord>();
    for (const root of roots) {
      if (!exists(root)) continue;
      if (!isDirectoryEntry(root)) return null;
      let orgs: string[];
      try {
        orgs = readdirSync(root);
      } catch {
        return null;
      }
      for (const org of orgs) {
        const orgURL = join(root, org);
        if (!isDirectoryEntry(orgURL)) continue;
        let accounts: string[];
        try {
          accounts = readdirSync(orgURL);
        } catch {
          return null;
        }
        for (const account of accounts) {
          const accountURL = join(orgURL, account);
          if (!isDirectoryEntry(accountURL)) continue;
          let names: string[];
          try {
            names = readdirSync(accountURL);
          } catch {
            return null;
          }
          const accountKey = accountURL;
          index.accounts.add(accountKey);
          for (const name of names) {
            if (!name.startsWith(ClaudeDesktopSessionIndex.recordPrefix) || !name.endsWith(".json")) continue;
            const url = join(accountURL, name);
            const record = readRecord(url, cache.get(url));
            if (!record) return null;
            fresh.set(url, record);
            if (!record.sessionID) continue;
            index.recorded.set(record.sessionID, accountKey);
            if (record.isArchived) index.archived.add(record.sessionID);
          }
        }
      }
    }
    cache.clear();
    for (const [key, value] of fresh) cache.set(key, value);
    return index;
  },
};

function isDirectoryEntry(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一份记录。没有 `cliSessionId` 的（刚建、CLI 还没吐 init）照常算一份，
 * 只是不对应任何会话；读不出、不是 JSON 回 null。
 */
function readRecord(url: string, cached: ClaudeDesktopRecord | undefined): ClaudeDesktopRecord | null {
  let stat;
  try {
    stat = statSync(url);
  } catch {
    return null;
  }
  const stamp = `${stat.mtimeMs / 1000}|${stat.size}`;
  if (cached && cached.stamp === stamp) return cached;
  let object: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    object = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const rawSessionID = object.cliSessionId;
  const sessionID = typeof rawSessionID === "string" && rawSessionID.length > 0 ? rawSessionID : null;
  return {
    stamp,
    sessionID,
    isArchived: object.isArchived === true,
  };
}

/** 记录对象里读 session id 的辅助（测试用，语义同 readRecord）。 */
export function desktopRecordFromObject(object: Record<string, unknown>): {
  sessionID: string | null;
  isArchived: boolean;
} {
  const record = recordValue(object);
  const raw = record.cliSessionId;
  return {
    sessionID: typeof raw === "string" && raw.length > 0 ? raw : null,
    isArchived: record.isArchived === true,
  };
}
