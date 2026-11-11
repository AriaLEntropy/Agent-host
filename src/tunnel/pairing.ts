import qrcode from "qrcode-terminal";
import { Config, saveConfig } from "../config.js";
import { deriveClaimToken, generateMasterKey, hashClaimToken } from "./e2ee.js";
import { pairingLink, publicRelayOrigin } from "./pair-link.js";

async function post(
  url: string,
  data: unknown,
  signal?: AbortSignal,
  headers?: Record<string, string>,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(data),
    signal,
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
  /** true 表示给已配对的 Host 加手机，成功后不改 hostId/hostToken */
  addDevice: boolean;
  /** 等手机确认；首次配对时保存配置并返回新配置，加手机时返回原配置 */
  waitForConfirmation: () => Promise<Config>;
  /** 停止等待（服务端会话会自然过期） */
  cancel: () => void;
};

/** 只创建一次配对会话，不做终端渲染；CLI 与桌面窗口共用 */
export async function createPairingTicket(
  config: Config,
  options: { addDevice?: boolean } = {},
): Promise<PairingTicket> {
  const addDevice = options.addDevice === true;
  if (addDevice) {
    if (!config.hostId || !config.hostToken || !config.e2eeMasterKey) {
      throw new Error("电脑还没有完成配对，不能添加手机");
    }
  }
  // 加手机复用 Host 的同一把主密钥：隧道握手只认 config.e2eeMasterKey，
  // 每台手机单独换钥匙需要改 relay→host 的握手协议。
  const masterKey = addDevice
    ? (config.e2eeMasterKey as string)
    : generateMasterKey();
  const claimToken = deriveClaimToken(masterKey);
  const created = addDevice
    ? await post(
        `${config.relay}/pair/device-session`,
        {
          hostId: config.hostId,
          claimTokenHash: hashClaimToken(claimToken),
          hostName: config.hostName,
        },
        undefined,
        { authorization: `Host ${config.hostToken}` },
      )
    : await post(`${config.relay}/pair/session`, {
        claimTokenHash: hashClaimToken(claimToken),
        hostName: config.hostName,
      });
  if (addDevice && created.status === 404) {
    throw new Error("Relay 版本过旧，不支持添加手机；请先升级 Relay");
  }
  if (addDevice && created.status === 401) {
    throw new Error("Host 凭据无效，请先重新配对这台电脑");
  }
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
  let abortWait: AbortController | null = null;

  return {
    link,
    expiresAt,
    addDevice,
    cancel: () => {
      cancelled = true;
      abortWait?.abort();
    },
    waitForConfirmation: async () => {
      const controller = new AbortController();
      abortWait = controller;
      // claim 之后只 confirm 一次；202 说明和 wait 抢跑了，回去接着等
      const confirm = async (): Promise<Config | null> => {
        for (;;) {
          if (cancelled) throw new PairingExpiredError("pairing cancelled");
          const response = await post(`${config.relay}/pair/confirm`, {
            pairId,
            confirmSecret,
          });
          if (response.status === 200) {
            // 加手机时 relay 不会再签发 hostToken；配置原样返回
            if (addDevice) return config;
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
          if (response.status === 429) {
            await sleep(3000);
            continue;
          }
          if (response.status === 202) return null;
          if (response.status === 410) {
            throw new PairingExpiredError("pairing QR expired");
          }
          throw new Error(`Pairing failed (${response.status})`);
        }
      };
      // 老 relay 没有 /pair/wait 时回退到原来的 confirm 轮询
      let legacy = false;
      while (Date.now() < expiresAt) {
        if (cancelled) throw new PairingExpiredError("pairing cancelled");
        if (legacy) {
          const done = await confirm();
          if (done) return done;
          await sleep(2000);
          continue;
        }
        let response: { status: number; data: any };
        try {
          response = await post(
            `${config.relay}/pair/wait`,
            { pairId, confirmSecret, timeoutMs: 25000 },
            controller.signal,
          );
        } catch {
          if (cancelled) throw new PairingExpiredError("pairing cancelled");
          await sleep(3000);
          continue;
        }
        if (response.status === 404) {
          legacy = true;
          continue;
        }
        // 429 只是这一拍被限流，配对会话还在，慢一拍接着等，不能当成失败退出
        if (response.status === 429) {
          await sleep(3000);
          continue;
        }
        if (response.status === 410) {
          throw new PairingExpiredError("pairing QR expired");
        }
        if (response.status !== 200) {
          throw new Error(`Pairing failed (${response.status})`);
        }
        if (response.data?.status === "claimed") {
          const done = await confirm();
          if (done) return done;
        }
        // pending：这一拍挂满了，接着挂起等 relay 通知
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
