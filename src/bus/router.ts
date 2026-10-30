import { acceptCommand } from "./commands.js";
import { ArtifactError, getArtifact, MAX_UPLOAD_BYTES, putUpload } from "./artifacts.js";
import { busStore, HostPlatform } from "./store.js";
import { PLUGIN_VERSION } from "../tunnel/version.js";

export const PROTOCOL_VERSION = "3.9";
export const SNAPSHOT_LONG_POLL_MS = 25_000;
export { MAX_UPLOAD_BYTES };

export type BusResponse = {
  status: number;
  body: Record<string, unknown>;
  /** 二进制响应（产物 / 上传）走这里；JSON 调用方继续只看 `body`。 */
  bytes?: Buffer;
  contentType?: string;
};

export function isBusPath(path: string): boolean {
  const pathname = path.split("?")[0];
  return pathname === "/bus" || pathname.startsWith("/bus/");
}

export async function routeBus(input: {
  method: string;
  path: string;
  agentId: string;
  hostName?: string;
  hostVersion?: string;
  platform?: HostPlatform;
  forwardsDsh?: boolean;
  longPollMs?: number;
  body?: Buffer;
  /** 上传请求的 `content-type` 头，由隧道层透传；其他路由忽略。 */
  contentType?: string;
}): Promise<BusResponse> {
  const pathname = input.path.split("?")[0];
  const since = new URLSearchParams(input.path.split("?")[1] ?? "").get("since");
  const method = input.method.toUpperCase();
  busStore.identify({
    agentId: input.agentId,
    hostName: input.hostName ?? "Agent Host",
    hostVersion: input.hostVersion ?? PLUGIN_VERSION,
    platform: input.platform ?? "windows",
  });

  if (method === "GET" && pathname === "/bus/describe") {
    return {
      status: 200,
      body: {
        protocolVersion: PROTOCOL_VERSION,
        hostVersion: input.hostVersion ?? PLUGIN_VERSION,
        agentId: input.agentId,
        hostKind: "agent-host",
        forwardsDsh: input.forwardsDsh ?? false,
      },
    };
  }
  if (method === "GET" && pathname === "/bus/snapshot") {
    const seq = busStore.currentSeq();
    const sinceSeq = since === null || since === "" ? null : Number(since);
    if (sinceSeq !== null && !Number.isNaN(sinceSeq) && sinceSeq === seq) {
      const changed = await busStore.waitForChange(seq, input.longPollMs ?? SNAPSHOT_LONG_POLL_MS);
      if (!changed && busStore.currentSeq() === seq) return { status: 304, body: {} };
    }
    return { status: 200, body: busStore.snapshot() };
  }
  if (method === "POST" && pathname === "/bus/commands") {
    let parsed: unknown;
    try {
      parsed = JSON.parse((input.body ?? Buffer.alloc(0)).toString("utf8") || "null");
    } catch {
      return { status: 400, body: { error: "invalid_command" } };
    }
    return acceptCommand(parsed);
  }
  if (method === "GET" && pathname.startsWith("/bus/artifacts/")) {
    const artifactId = pathname.slice("/bus/artifacts/".length);
    try {
      const artifact = await getArtifact(artifactId);
      if (!artifact) return { status: 404, body: { error: "not_found" } };
      return {
        status: 200,
        body: {},
        bytes: artifact.bytes,
        contentType: artifact.contentType,
      };
    } catch {
      // 落盘错误不抛给隧道层，按普通 JSON 错误回给手机。
      return { status: 500, body: { error: "artifact_read_failed" } };
    }
  }
  if (method === "PUT" && pathname.startsWith("/bus/uploads/")) {
    const artifactId = pathname.slice("/bus/uploads/".length);
    const body = input.body ?? Buffer.alloc(0);
    if (body.length > MAX_UPLOAD_BYTES) {
      return { status: 413, body: { error: "too_large" } };
    }
    try {
      const stored = await putUpload(artifactId, body, input.contentType);
      return {
        status: 201,
        body: { artifactId: stored.artifactId, size: stored.size },
      };
    } catch (error) {
      if (error instanceof ArtifactError) {
        if (error.code === "invalid_id") {
          return { status: 400, body: { error: "invalid_artifact_id" } };
        }
        if (error.code === "unsupported_type") {
          return { status: 415, body: { error: "unsupported_media_type" } };
        }
        return { status: 413, body: { error: "too_large" } };
      }
      return { status: 500, body: { error: "artifact_write_failed" } };
    }
  }
  return { status: 404, body: { error: "not_found" } };
}
