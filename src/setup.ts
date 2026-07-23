import { isIP } from "node:net";
import { createInterface } from "node:readline/promises";
import type { AppConfig, ConfigStore } from "./config.js";
import { setupSummary } from "./launch.js";
import { TunnelManager } from "./tunnels.js";

export interface InstallationOptions {
  adminToken?: string;
  hasPublicIp?: boolean;
  publicAddress?: string;
}

export interface SetupResult {
  config: AppConfig;
  adminToken?: string;
  cloudflareMessage?: string;
}

function interactiveTerminal(): boolean { return Boolean(process.stdin.isTTY && process.stdout.isTTY); }

async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await prompt.question(question)).trim(); } finally { prompt.close(); }
}

async function confirm(question: string, defaultValue: boolean): Promise<boolean> {
  const hint = defaultValue ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await ask(`${question} ${hint} `)).toLowerCase();
    if (!answer) return defaultValue;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
    console.log("Please answer yes or no.");
  }
}

async function chooseAdminToken(): Promise<string | undefined> {
  while (true) {
    const choice = await ask("Administrator/connection token: [1] automatically generate (recommended), [2] enter my own token [1]: ");
    if (!choice || choice === "1") return undefined;
    if (choice === "2") {
      const token = await ask("Enter any non-empty token (letters and numbers are both accepted): ");
      if (token) return token;
      console.log("The token must not be empty.");
      continue;
    }
    console.log("Please choose 1 or 2.");
  }
}

async function askPublicAddress(): Promise<{ hasPublicIp: boolean; publicAddress?: string }> {
  const hasPublicIp = await confirm("Does this device have a directly reachable public IP address?", true);
  if (!hasPublicIp) return { hasPublicIp };
  const detected = await detectPublicIp();
  if (detected) {
    console.log(`Detected public IP: ${detected}`);
    if (await confirm("Use this address when displaying connection URLs?", true)) return { hasPublicIp, publicAddress: detected };
  }
  while (true) {
    const address = await ask("Enter the device public IPv4 or IPv6 address: ");
    if (isIP(address)) return { hasPublicIp, publicAddress: address };
    console.log("Enter a valid IPv4 or IPv6 address.");
  }
}

export async function detectPublicIp(fetcher: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const response = await fetcher("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return undefined;
    const address = (await response.text()).match(/^ip=(.+)$/m)?.[1]?.trim();
    return address && isIP(address) ? address : undefined;
  } catch {
    return undefined;
  }
}

export async function prepareInstallation(store: ConfigStore, options: InstallationOptions = {}): Promise<SetupResult> {
  const config = await store.loadConfig();
  return persistInstallation(store, config, options);
}

async function persistInstallation(store: ConfigStore, config: AppConfig, options: InstallationOptions): Promise<SetupResult> {
  if (options.hasPublicIp !== undefined) config.network.hasPublicIp = options.hasPublicIp;
  if (options.publicAddress) config.network.publicAddress = options.publicAddress;
  else if (options.hasPublicIp === false) delete config.network.publicAddress;
  await store.saveConfig(config);
  const adminToken = await store.ensureAdminToken(options.adminToken);
  return { config, ...(adminToken ? { adminToken } : {}) };
}

export async function runInteractiveSetup(store: ConfigStore, publicUrl?: string): Promise<SetupResult> {
  const needsAdminToken = !(await store.hasAdminToken());
  const config = await store.loadConfig();
  if (publicUrl) config.publicBaseUrl = publicUrl;

  let adminToken: string | undefined;
  let publicAccess: Pick<InstallationOptions, "hasPublicIp" | "publicAddress"> = {};
  let installCloudflare = false;
  const tunnels = new TunnelManager(config);

  if (needsAdminToken && interactiveTerminal()) {
    console.log("\nSecure Host MCP first-time setup");
    publicAccess = await askPublicAddress();
    const inspection = await tunnels.inspect();
    if (inspection.cloudflared.installed) console.log("Cloudflare Tunnel (cloudflared) is already installed.");
    else installCloudflare = await confirm("Install Cloudflare Tunnel (cloudflared) now?", !publicAccess.hasPublicIp);
    console.log("The initial token is used both as the web-console administrator token and as a full-access MCP connection token.");
    adminToken = await chooseAdminToken();
  }

  const prepared = await persistInstallation(store, config, { ...publicAccess, ...(adminToken ? { adminToken } : {}) });

  let cloudflareMessage: string | undefined;
  if (installCloudflare) {
    try {
      const result = await tunnels.install("cloudflared", true);
      cloudflareMessage = `Cloudflare Tunnel installed: ${result.destination}. Configure a tunnel, then set publicBaseUrl in config.json to its HTTPS address.`;
    } catch (error) {
      cloudflareMessage = `Cloudflare Tunnel installation failed: ${error instanceof Error ? error.message : String(error)}. Run "secure-host-mcp tunnel install cloudflared --yes" to retry.`;
    }
  }
  return { ...prepared, ...(cloudflareMessage ? { cloudflareMessage } : {}) };
}

export function printSetupReport(store: ConfigStore, result: SetupResult): void {
  console.log(`Configuration: ${store.configPath}`);
  console.log(`Token configuration: ${store.tokensPath}`);
  for (const message of setupSummary(result.config)) console.log(message);
  if (result.adminToken) console.log(`ADMINISTRATOR / MCP CONNECTION TOKEN: ${result.adminToken}`);
  else console.log("Administrator token already exists.");
  if (result.cloudflareMessage) console.log(result.cloudflareMessage);
}
