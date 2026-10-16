import { acceptCommand } from "./commands.js";
import { busStore, HostPlatform } from "./store.js";
import { PLUGIN_VERSION } from "../tunnel/version.js";

export const PROTOCOL_VERSION = "3.9";
export const SNAPSHOT_LONG_POLL_MS = 25_000;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export type BusResponse = {
  status: number;
  body: Record<string, unknown>;
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
    return { status: 404, body: { error: "not_found" } };
  }
  if (method === "PUT" && pathname.startsWith("/bus/uploads/")) {
    if ((input.body?.length ?? 0) > MAX_UPLOAD_BYTES) {
      return { status: 413, body: { error: "too_large" } };
    }
    return { status: 404, body: { error: "not_found" } };
  }
  return { status: 404, body: { error: "not_found" } };
}
