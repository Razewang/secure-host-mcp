#!/usr/bin/env node
import { Command } from "commander";
import { ConfigStore } from "./config.js";
import { startServer } from "./server.js";
import { TunnelManager } from "./tunnels.js";
import { startPrivilegeHelper } from "./privilege.js";
import { enableLanHttp, prepareInteractiveLaunch, setupSummary } from "./launch.js";
import { packageVersion } from "./version.js";

const program = new Command().name("secure-host-mcp").description("Cross-platform remote terminal MCP host").version(packageVersion());
async function runServer(store = new ConfigStore()): Promise<void> {
  const running = await startServer(store); const address = running.server.address(); const adminAddress = running.adminServer.address();
  console.log(`MCP: ${typeof address === "object" && address ? `${address.address}:${address.port}` : String(address)}`);
  console.log(`Admin: ${typeof adminAddress === "object" && adminAddress ? `${adminAddress.address}:${adminAddress.port}` : String(adminAddress)}`);
  const stop = () => void running.close().then(() => process.exit(0)); process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
function printSetupSummary(config: Awaited<ReturnType<ConfigStore["loadConfig"]>>): void {
  for (const message of setupSummary(config)) console.log(message);
}
program.command("setup").description("Create configuration and the owner token").option("--public-url <url>").option("--allow-lan-http").action(async (options: { publicUrl?: string; allowLanHttp?: boolean }) => {
  const store = new ConfigStore(); const config = await store.loadConfig();
  if (options.publicUrl) config.publicBaseUrl = options.publicUrl;
  if (options.allowLanHttp) enableLanHttp(config);
  await store.saveConfig(config); const token = await store.ensureOwnerToken();
  console.log(`Configuration: ${store.configPath}`); printSetupSummary(config); if (token) console.log(`OWNER TOKEN (shown once): ${token}`); else console.log("Owner token already exists.");
});
program.command("start").description("Start the MCP and administration HTTP servers").action(async () => runServer());
program.command("launch", { hidden: true }).description("Initialize on first run, then start the servers").action(async () => {
  const store = new ConfigStore(); const prepared = await prepareInteractiveLaunch(store);
  console.log(`Configuration: ${store.configPath}`);
  printSetupSummary(prepared.config);
  if (prepared.ownerToken) console.log(`OWNER TOKEN (shown once): ${prepared.ownerToken}`);
  else console.log("Owner token already exists.");
  await runServer(store);
});
program.command("helper").description("Start the local privileged helper (must already be root/SYSTEM)").action(async () => { const store = new ConfigStore(); const server = await startPrivilegeHelper(await store.loadConfig(), store); console.log("Privileged helper listening on 127.0.0.1:8769"); const stop = () => server.close(() => process.exit(0)); process.on("SIGINT", stop); process.on("SIGTERM", stop); });
program.command("doctor").description("Inspect configuration and tunnel clients").action(async () => { const store = new ConfigStore(); const config = await store.loadConfig(); console.log(JSON.stringify({ configPath: store.configPath, publicBaseUrl: config.publicBaseUrl, tunnels: await new TunnelManager(config).inspect() }, null, 2)); });
program.command("tunnel").argument("<action>", "inspect|start|stop|install-plan|install").argument("[kind]", "cloudflared|frpc").option("--yes", "confirm installation from the official release").action(async (action: string, rawKind: string | undefined, options: { yes?: boolean }) => { const config = await new ConfigStore().loadConfig(); const tunnels = new TunnelManager(config); const kind = rawKind === "frpc" ? "frpc" : "cloudflared"; if (action === "inspect") console.log(JSON.stringify(await tunnels.inspect(), null, 2)); else if (action === "start") console.log(JSON.stringify(await tunnels.start(kind), null, 2)); else if (action === "stop") tunnels.stop(kind); else if (action === "install-plan") console.log(JSON.stringify(tunnels.installPlan(kind), null, 2)); else if (action === "install") console.log(JSON.stringify(await tunnels.install(kind, Boolean(options.yes)), null, 2)); else throw new Error(`Unknown action: ${action}`); });
await program.parseAsync();
