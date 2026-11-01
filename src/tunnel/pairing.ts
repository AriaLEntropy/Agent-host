import qrcode from "qrcode-terminal";
import { Config, saveConfig } from "../config.js";
import { deriveClaimToken, generateMasterKey, hashClaimToken } from "./e2ee.js";
import { pairingLink, publicRelayOrigin } from "./pair-link.js";

async function post(url: string, data: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  return { status: response.status, data: (await response.json()) as any };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setTitle(text: string) {
  if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${text}\x07`);
}

export class PairingExpiredError extends Error {}

/** 一次配对会话：二维码内容、过期时间、等待确认与取消 */
export type PairingTicket = {
  /** 手机扫码用的配对链接 */
  link: string;
  /** Unix 毫秒时间戳 */
  expiresAt: number;
  /** 等手机确认；成功后保存配置并返回新配置 */
  waitForConfirmation: () => Promise<Config>;
  /** 停止轮询（服务端会话会自然过期） */
  cancel: () => void;
};

/** 只创建一次配对会话，不做终端渲染；CLI 与桌面窗口共用 */
export async function createPairingTicket(config: Config): Promise<PairingTicket> {
  const masterKey = generateMasterKey();
  const claimToken = deriveClaimToken(masterKey);
  const created = await post(`${config.relay}/pair/session`, {
    claimTokenHash: hashClaimToken(claimToken),
    hostName: config.hostName,
  });
  if (created.status !== 201) {
    throw new Error(`Relay rejected pairing session (${created.status})`);
  }
  const { pairId, confirmSecret, expiresAt } = created.data as {
    pairId: string;
    confirmSecret: string;
    expiresAt: number;
  };
  const origin = publicRelayOrigin(config.relay, config.publicRelayUrl);
  const link = pairingLink(origin, pairId, masterKey);
  let cancelled = false;

  return {
    link,
    expiresAt,
    cancel: () => {
      cancelled = true;
    },
    waitForConfirmation: async () => {
      while (Date.now() < expiresAt) {
        if (cancelled) throw new PairingExpiredError("pairing cancelled");
        const response = await post(`${config.relay}/pair/confirm`, {
          pairId,
          confirmSecret,
        });
        if (response.status === 200) {
          const confirmed = response.data as Record<string, any>;
          const next: Config = {
            ...config,
            hostId: confirmed.hostId,
            hostToken: confirmed.hostToken,
            e2eeMasterKey: masterKey,
          };
          await saveConfig(next);
          return next;
        }
        if (response.status !== 202) {
          throw new Error(`Pairing failed (${response.status})`);
        }
        await sleep(2000);
      }
      throw new PairingExpiredError("pairing QR expired");
    },
  };
}

export async function pair(config: Config): Promise<Config> {
  let attempt = 1;

  for (;;) {
    const ticket = await createPairingTicket(config);
    setTitle("Agent-host pairing — waiting for scan");
    console.log(
      `Pairing QR #${attempt} (expires ${new Date(ticket.expiresAt).toLocaleTimeString()})`,
    );

    let lastShown = -1;
    let saved = false;
    const showCountdown = (left: number) => {
      if (left === lastShown) return;
      lastShown = left;
      setTitle(`Agent-host pairing — ${left}s remaining`);
      if (process.stdout.isTTY) {
        if (saved) process.stdout.write("\x1b[u");
        process.stdout.write(`\rPairing QR expires in ${left}s   `);
        process.stdout.write("\x1b[s");
        saved = true;
      } else {
        console.log(`Pairing QR expires in ${left}s`);
      }
    };
    showCountdown(Math.max(0, Math.ceil((ticket.expiresAt - Date.now()) / 1000)));
    if (process.stdout.isTTY) process.stdout.write("\n");
    const countdown = setInterval(() => {
      showCountdown(Math.max(0, Math.ceil((ticket.expiresAt - Date.now()) / 1000)));
    }, 1000);

    qrcode.generate(ticket.link, { small: true }, (output) => console.log(output));
    console.log(ticket.link);

    try {
      const next = await ticket.waitForConfirmation();
      setTitle("Agent-host — paired");
      console.log(`Paired as ${config.hostName} at ${new Date().toISOString()}`);
      return next;
    } catch (error) {
      if (!(error instanceof PairingExpiredError)) throw error;
      setTitle("Agent-host pairing — expired, refreshing");
      console.log("Pairing QR expired; generating a new one...\n");
      attempt += 1;
    } finally {
      if (countdown) clearInterval(countdown);
      if (process.stdout.isTTY) process.stdout.write("\r");
    }
  }
}
