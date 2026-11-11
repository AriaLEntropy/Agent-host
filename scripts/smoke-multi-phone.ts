/**
 * 一台电脑连多台手机：本地 Relay + 同一个 Host，两个独立 client token 同时开隧道。
 *
 * 覆盖：加手机配对不改 hostId、两台同时在线、设备列表、移除一台不影响另一台、
 * 最后一台不能通过“移除”删掉（要全部断开走解除配对）。
 */
import {
  createChecks,
  createHarness,
  jsonBody,
  sleep,
} from "./lib/sealed-harness.js";
import { deriveClaimToken } from "../src/tunnel/e2ee.js";
import { createPairingTicket } from "../src/tunnel/pairing.js";
import type { Config } from "../src/config.js";

async function postHost(
  base: string,
  path: string,
  hostToken: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, any> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Host ${hostToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return {
    status: response.status,
    data: (await response.json().catch(() => ({}))) as Record<string, any>,
  };
}

async function main() {
  const harness = await createHarness({ hostName: "Multi Phone" });
  const { check, finish } = createChecks();
  try {
    const hostId = String(harness.hostId);
    const hostToken = String(harness.hostToken);

    // 第二台手机用同一个主密钥，走 Host 的“添加设备”配对
    const config: Config = {
      hostName: "Multi Phone",
      relay: harness.relayUrl,
      publicRelayUrl: harness.relayUrl,
      dshPort: 1,
      hostId,
      hostToken,
      e2eeMasterKey: harness.masterKey,
    };
    const ticket = await createPairingTicket(config, { addDevice: true });
    check("host add-device ticket", ticket.addDevice === true, `addDevice=${ticket.addDevice}`);
    check("link carries the host master key", ticket.link.includes("key="), ticket.link.includes("key=") ? "yes" : "no");

    const pairId = new URLSearchParams(new URL(ticket.link).hash.split("?")[1]).get("id") ?? "";
    const waiting = ticket.waitForConfirmation();
    const claimToken = deriveClaimToken(harness.masterKey);
    const claimed = await fetch(`${harness.relayUrl}/pair/claim-device`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairId,
        claimToken,
        deviceLabel: "Second phone",
        platform: "android",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const claimedBody = (await claimed.json()) as Record<string, any>;
    check(
      "second claim keeps hostId",
      claimed.status === 200 && claimedBody.hostId === hostId,
      `status=${claimed.status} hostId=${String(claimedBody.hostId)}`,
    );
    check(
      "second claim returns its clientId",
      typeof claimedBody.clientId === "string" && claimedBody.clientId.length > 0,
      `clientId=${String(claimedBody.clientId)}`,
    );
    const secondToken = String(claimedBody.clientToken);

    const next = await waiting;
    check(
      "confirm does not rotate host token",
      next.hostId === hostId && next.hostToken === hostToken,
      `hostToken=${next.hostToken === hostToken ? "unchanged" : "rotated"}`,
    );

    const first = harness.tunnel;
    const second = await harness.openTunnelWith(secondToken);

    const firstDescribe = jsonBody(await first.request("GET", "/bus/describe"));
    const secondDescribe = jsonBody(await second.request("GET", "/bus/describe"));
    check(
      "both tunnels reach the same host",
      firstDescribe.hostKind === "agent-host" && secondDescribe.hostKind === "agent-host",
      `first=${String(firstDescribe.hostKind)} second=${String(secondDescribe.hostKind)}`,
    );

    const listResponse = await fetch(
      `${harness.relayUrl}/host-management/${encodeURIComponent(hostId)}/devices`,
      {
        headers: { authorization: `Host ${hostToken}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const list = (await listResponse.json()) as {
      devices?: Array<{ id: string; deviceLabel: string; online: boolean }>;
    };
    check(
      "device list has both phones",
      listResponse.status === 200 && (list.devices?.length ?? 0) === 2,
      `status=${listResponse.status} count=${String(list.devices?.length)}`,
    );
    check(
      "device list marks both phones online",
      (list.devices ?? []).every((device) => device.online === true),
      `online=${(list.devices ?? []).map((device) => device.online).join(",")}`,
    );
    const removable = list.devices?.find((device) => device.deviceLabel === "Second phone");
    check("device list labels the second phone", Boolean(removable), `id=${String(removable?.id)}`);

    // 手机端走 Host 的 /bus/devices 代理，不直接拿 Host token
    const busList = jsonBody(await first.request("GET", "/bus/devices"));
    check(
      "bus device list reaches the phone UI",
      Array.isArray(busList.devices) && busList.devices.length === 2,
      `count=${String((busList.devices as unknown[] | undefined)?.length)}`,
    );

    const revoke = await first.request(
      "POST",
      `/bus/devices/${encodeURIComponent(String(removable?.id))}/revoke`,
      Buffer.from("{}"),
    );
    check("phone UI revokes the second phone", revoke.status === 200, `status=${revoke.status}`);

    let secondClosed = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await second.request("GET", "/bus/describe", undefined, 500);
      } catch {
        secondClosed = true;
        break;
      }
      await sleep(100);
    }
    check("revoked phone tunnel closes", secondClosed, `closed=${secondClosed}`);

    const firstAfter = jsonBody(await first.request("GET", "/bus/describe"));
    check(
      "remaining phone still works",
      firstAfter.hostKind === "agent-host",
      `hostKind=${String(firstAfter.hostKind)}`,
    );

    const lastRevoke = await postHost(
      harness.relayUrl,
      `/host-management/${encodeURIComponent(hostId)}/devices/${encodeURIComponent(String(list.devices?.[0]?.id))}/revoke`,
      hostToken,
    );
    check("last phone cannot be revoked", lastRevoke.status === 409, `status=${lastRevoke.status}`);
  } finally {
    await harness.close();
    finish();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
