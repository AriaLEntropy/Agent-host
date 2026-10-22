import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createChecks,
  createHarness,
  sleep,
  type BusSocket,
} from "./lib/sealed-harness.js";

const SEALED_LIMIT = 8;
const BUS_WS_LIMIT = 16;
const PENDING_HTTP_LIMIT = 32;

async function main() {
  const dsh = createServer(() => {});
  await new Promise<void>((resolve) => dsh.listen(0, "127.0.0.1", resolve));
  const dshPort = (dsh.address() as AddressInfo).port;

  const harness = await createHarness({ hostName: "Capacity Host", dshPort });
  const { check, finish } = createChecks();
  const sockets: BusSocket[] = [];

  try {
    const tunnels = [harness.tunnel];
    for (let index = 1; index < SEALED_LIMIT; index += 1)
      tunnels.push(await harness.openTunnel());
    check(
      `${SEALED_LIMIT} sealed tunnels stay open`,
      tunnels.length === SEALED_LIMIT,
      `open=${tunnels.length}`,
    );

    let tunnelRejection = "";
    try {
      await harness.openTunnel();
    } catch (error) {
      tunnelRejection = error instanceof Error ? error.message : String(error);
    }
    check(
      `sealed tunnel #${SEALED_LIMIT + 1} is rejected`,
      /503/.test(tunnelRejection),
      tunnelRejection || "opened unexpectedly",
    );

    for (let index = 0; index < BUS_WS_LIMIT; index += 1)
      sockets.push(await harness.tunnel.openSocket("/bus/ws"));
    check(
      `${BUS_WS_LIMIT} /bus/ws channels stay open`,
      sockets.length === BUS_WS_LIMIT,
      `open=${sockets.length}`,
    );
    let socketRejection = "";
    try {
      await harness.tunnel.openSocket("/bus/ws");
    } catch (error) {
      socketRejection = error instanceof Error ? error.message : String(error);
    }
    check(
      `/bus/ws channel #${BUS_WS_LIMIT + 1} is closed`,
      /1013/.test(socketRejection),
      socketRejection || "opened unexpectedly",
    );
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await sleep(200);

    const pendingTunnel = tunnels[1];
    for (let index = 0; index < PENDING_HTTP_LIMIT; index += 1) {
      const request = pendingTunnel.request("GET", `/slow-${index}`, undefined, 30_000);
      request.catch(() => undefined);
    }
    await sleep(500);
    const overflow = await pendingTunnel.request("GET", "/slow-overflow", undefined, 5_000);
    const overflowBody = overflow.body.toString("utf8");
    check(
      `pending HTTP request #${PENDING_HTTP_LIMIT + 1} is rejected`,
      overflow.status === 429 && overflowBody.includes("too_many_tunnels"),
      `status=${overflow.status} body=${overflowBody.slice(0, 80)}`,
    );
  } finally {
    for (const socket of sockets) socket.close();
    await harness.close();
    dsh.closeAllConnections();
    await new Promise<void>((resolve) => dsh.close(() => resolve()));
  }

  finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
