#!/usr/bin/env node
import { Command } from "commander";
import { isIP } from "node:net";
import { createInterface } from "node:readline/promises";
import { ConfigStore } from "./config.js";
import { startServer } from "./server.js";
import { TunnelManager } from "./tunnels.js";
import { startPrivilegeHelper } from "./privilege.js";
import { detectPublicIp, enableLanHttp, prepareInteractiveLaunch, setupSummary } from "./launch.js";
import { packageVersion } from "./version.js";

const program = new Command().name("secure-host-mcp").description("Cross-platform remote terminal MCP host").version(packageVersion());
const interactiveTerminal = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);
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
async function initializeInstallation(store: ConfigStore): Promise<{ config: Awaited<ReturnType<ConfigStore["loadConfig"]>>; ownerToken?: string; cloudflareMessage?: string }> {
  const needsOwner = !(await store.hasOwnerToken());
  let adminToken: string | undefined;
  let publicAccess: { hasPublicIp?: boolean; publicAddress?: string } = {};
  let installCloudflare = false;
  const config = await store.loadConfig();
  if (needsOwner && interactiveTerminal()) {
    console.log("\nSecure Host MCP first-time setup");
    publicAccess = await askPublicAddress();
    const inspection = await new TunnelManager(config).inspect();
    if (inspection.cloudflared.installed) console.log("Cloudflare Tunnel (cloudflared) is already installed.");
    else installCloudflare = await confirm("Install Cloudflare Tunnel (cloudflared) now?", !publicAccess.hasPublicIp);
    console.log("The initial token is used both as the web-console administrator token and as a full-access MCP connection token.");
    adminToken = await chooseAdminToken();
  }
  const prepared = await prepareInteractiveLaunch(store, { ...publicAccess, ...(adminToken ? { adminToken } : {}) });
  let cloudflareMessage: string | undefined;
  if (installCloudflare) {
    try {
      const result = await new TunnelManager(prepared.config).install("cloudflared", true);
      cloudflareMessage = `Cloudflare Tunnel installed: ${result.destination}. Configure a tunnel, then set publicBaseUrl in config.json to its HTTPS address.`;
    } catch (error) {
      cloudflareMessage = `Cloudflare Tunnel installation failed: ${error instanceof Error ? error.message : String(error)}. Run "secure-host-mcp tunnel install cloudflared --yes" to retry.`;
    }
  }
  return { ...prepared, ...(cloudflareMessage ? { cloudflareMessage } : {}) };
}
async function runServer(store = new ConfigStore()): Promise<void> {
  const running = await startServer(store); const address = running.server.address(); const adminAddress = running.adminServer.address();
  console.log(`MCP: ${typeof address === "object" && address ? `${address.address}:${address.port}` : String(address)}`);
  console.log(`Admin: ${typeof adminAddress === "object" && adminAddress ? `${adminAddress.address}:${adminAddress.port}` : String(adminAddress)}`);
  const stop = () => void running.close().then(() => process.exit(0)); process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
function printSetupSummary(config: Awaited<ReturnType<ConfigStore["loadConfig"]>>): void {
  for (const message of setupSummary(config)) console.log(message);
}
program.command("setup").description("Run first-time setup and create the administrator token").option("--public-url <url>").option("--allow-lan-http").action(async (options: { publicUrl?: string; allowLanHttp?: boolean }) => {
  const store = new ConfigStore(); const config = await store.loadConfig();
  if (options.publicUrl) config.publicBaseUrl = options.publicUrl;
  if (options.allowLanHttp) enableLanHttp(config);
  await store.saveConfig(config);
  const prepared = await initializeInstallation(store);
  console.log(`Configuration: ${store.configPath}`);
  console.log(`Token configuration: ${store.tokensPath}`);
  printSetupSummary(prepared.config);
  if (prepared.ownerToken) console.log(`ADMINISTRATOR / MCP CONNECTION TOKEN: ${prepared.ownerToken}`);
  else console.log("Administrator token already exists.");
  if (prepared.cloudflareMessage) console.log(prepared.cloudflareMessage);
});
program.command("start").description("Start the MCP and administration HTTP servers").action(async () => runServer());
program.command("launch", { hidden: true }).description("Initialize on first run, then start the servers").action(async () => {
  const store = new ConfigStore(); const prepared = await initializeInstallation(store);
  console.log(`Configuration: ${store.configPath}`);
  console.log(`Token configuration: ${store.tokensPath}`);
  printSetupSummary(prepared.config);
  if (prepared.ownerToken) console.log(`ADMINISTRATOR / MCP CONNECTION TOKEN: ${prepared.ownerToken}`);
  else console.log("Administrator token already exists.");
  if (prepared.cloudflareMessage) console.log(prepared.cloudflareMessage);
  await runServer(store);
});
program.command("helper").description("Start the local privileged helper (must already be root/SYSTEM)").action(async () => { const store = new ConfigStore(); const server = await startPrivilegeHelper(await store.loadConfig(), store); console.log("Privileged helper listening on 127.0.0.1:8769"); const stop = () => server.close(() => process.exit(0)); process.on("SIGINT", stop); process.on("SIGTERM", stop); });
program.command("doctor").description("Inspect configuration and tunnel clients").action(async () => { const store = new ConfigStore(); const config = await store.loadConfig(); console.log(JSON.stringify({ configPath: store.configPath, publicBaseUrl: config.publicBaseUrl, tunnels: await new TunnelManager(config).inspect() }, null, 2)); });
program.command("tunnel").argument("<action>", "inspect|start|stop|install-plan|install").argument("[kind]", "cloudflared|frpc").option("--yes", "confirm installation from the official release").action(async (action: string, rawKind: string | undefined, options: { yes?: boolean }) => { const config = await new ConfigStore().loadConfig(); const tunnels = new TunnelManager(config); const kind = rawKind === "frpc" ? "frpc" : "cloudflared"; if (action === "inspect") console.log(JSON.stringify(await tunnels.inspect(), null, 2)); else if (action === "start") console.log(JSON.stringify(await tunnels.start(kind), null, 2)); else if (action === "stop") tunnels.stop(kind); else if (action === "install-plan") console.log(JSON.stringify(tunnels.installPlan(kind), null, 2)); else if (action === "install") console.log(JSON.stringify(await tunnels.install(kind, Boolean(options.yes)), null, 2)); else throw new Error(`Unknown action: ${action}`); });
await program.parseAsync();
