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

export async function pair(config: Config): Promise<Config> {
  const masterKey = generateMasterKey();
  const claimToken = deriveClaimToken(masterKey);
  let attempt = 1;

  for (;;) {
    const created = await post(`${config.relay}/pair/session`, {
      claimTokenHash: hashClaimToken(claimToken),
      hostName: config.hostName,
    });
    if (created.status !== 201)
      throw new Error(`Relay rejected pairing session (${created.status})`);
    const { pairId, confirmSecret, expiresAt } = created.data as {
      pairId: string;
      confirmSecret: string;
      expiresAt: number;
    };

    const origin = publicRelayOrigin(config.relay, config.publicRelayUrl);
    const qr = pairingLink(origin, pairId, masterKey);
    setTitle("Agent-host pairing — waiting for scan");
    console.log(`Pairing QR #${attempt} (expires ${new Date(expiresAt).toLocaleTimeString()})`);

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
    showCountdown(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    if (process.stdout.isTTY) process.stdout.write("\n");
    const countdown = setInterval(() => {
      showCountdown(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    }, 1000);

    qrcode.generate(qr, { small: true }, (output) => console.log(output));
    console.log(qr);

    let confirmed: Record<string, any> | undefined;
    try {
      while (Date.now() < expiresAt) {
        const response = await post(`${config.relay}/pair/confirm`, {
          pairId,
          confirmSecret,
        });
        if (response.status === 200) {
          confirmed = response.data;
          break;
        }
        if (response.status !== 202)
          throw new Error(`Pairing failed (${response.status})`);
        await sleep(2000);
      }
    } finally {
      if (countdown) clearInterval(countdown);
      if (process.stdout.isTTY) process.stdout.write("\r");
    }

    if (confirmed) {
      const next: Config = {
        ...config,
        hostId: confirmed.hostId,
        hostToken: confirmed.hostToken,
        e2eeMasterKey: masterKey,
      };
      await saveConfig(next);
      setTitle("Agent-host — paired");
      console.log(`Paired as ${config.hostName} at ${new Date().toISOString()}`);
      return next;
    }

    setTitle("Agent-host pairing — expired, refreshing");
    console.log("Pairing QR expired; generating a new one...\n");
    attempt += 1;
  }
}
