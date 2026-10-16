import { busStore } from "./store.js";

export function openBusWebSocket(path: string, send: (text: string) => void) {
  const sinceRaw = new URLSearchParams(path.split("?")[1] ?? "").get("since");
  const since = sinceRaw === null || sinceRaw === "" ? null : Number(sinceRaw);
  if (since === null || Number.isNaN(since) || since !== busStore.currentSeq()) {
    send(JSON.stringify({ type: "snapshot", snapshot: busStore.snapshot() }));
  }
  return busStore.subscribe((event) => {
    send(JSON.stringify({ type: "event", event }));
  });
}
