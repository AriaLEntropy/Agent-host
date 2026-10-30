import { homedir } from "node:os";
import { join } from "node:path";

/**
 * DSH 的本机目录。默认 ~/.dsh。
 *
 * 参考实现不认 shell 里的 DSH_HOME；这里允许 AGENT_HOST_DSH_HOME 覆盖，
 * 只给测试和隔离环境用，避免把日常 ~/.dsh 当成测试目录。
 */
export type DshPaths = {
  home: string;
  sessionsDirectory: string;
  projectionCacheDirectory: string;
  credentialsFile: string;
};

export function dshPaths(home = process.env.AGENT_HOST_DSH_HOME?.trim() || join(homedir(), ".dsh")): DshPaths {
  return {
    home,
    sessionsDirectory: join(home, "sessions"),
    projectionCacheDirectory: join(home, "storages", "session_projcache", "sessions"),
    credentialsFile: join(home, ".credentials.yaml"),
  };
}

export function projectionCacheFile(paths: DshPaths, sessionId: string) {
  return join(paths.projectionCacheDirectory, `${sessionId}.json`);
}
