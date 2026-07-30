#!/usr/bin/env node
import { Command } from "commander";
import { ConfigStore } from "./config.js";
import { startServer } from "./server.js";
import { TunnelManager } from "./tunnels.js";
import { startPrivilegeHelper } from "./privilege.js";
import { ServiceController, type ServiceStatus } from "./service.js";
import { printSetupReport, runInteractiveSetup } from "./setup.js";
import { packageVersion } from "./version.js";

const program = new Command().name("secure-host-mcp").description("Cross-platform remote terminal MCP host").version(packageVersion());

function entryPath(): string {
  const entry = process.argv[1];
  if (!entry) throw new Error("Unable to determine the Secure Host MCP entry point");
  return entry;
}

function printServiceStatus(status: ServiceStatus): void {
  if (status.status === "stopped") {
    console.log("Secure Host MCP is stopped.");
    if (status.stalePid) console.log(`Removed stale service state for PID ${status.stalePid}.`);
    return;
  }
  console.log("Secure Host MCP is running.");
  console.log(`PID: ${status.pid}`);
  console.log(`Mode: ${status.mode}`);
  console.log(`Started: ${status.startedAt}`);
  if (status.logPath) console.log(`Log: ${status.logPath}`);
}

async function runServer(store = new ConfigStore(), mode: "foreground" | "daemon" = "foreground"): Promise<void> {
  const service = new ServiceController(store);
  await service.assertStopped();
  const running = await startServer(store);
  try {
    await service.recordRunning(mode);
  } catch (error) {
    await running.close();
    throw error;
  }
  const address = running.server.address(); const adminAddress = running.adminServer.address();
  console.log(`MCP: ${typeof address === "object" && address ? `${address.address}:${address.port}` : String(address)}`);
  console.log(`Admin: ${typeof adminAddress === "object" && adminAddress ? `${adminAddress.address}:${adminAddress.port}` : String(adminAddress)}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void running.close()
      .then(() => service.clear())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function startInBackground(store = new ConfigStore()): Promise<void> {
  if (!(await store.hasAdminToken())) throw new Error("ADMIN_TOKEN_MISSING: Run setup before starting the server");
  const status = await new ServiceController(store).startDaemon(entryPath());
  printServiceStatus(status);
}

program.command("setup").description("Run first-time setup and create the administrator token").option("--public-url <url>").option("--workspace <directory>", "coding workspace root").action(async (options: { publicUrl?: string; workspace?: string }) => {
  const store = new ConfigStore();
  printSetupReport(store, await runInteractiveSetup(store, options.publicUrl, options.workspace));
});
program.command("start").description("Start the MCP and administration HTTP servers").option("-d, --daemon", "run in the background").action(async (options: { daemon?: boolean }) => {
  if (options.daemon) await startInBackground();
  else await runServer();
});
program.command("stop").description("Stop the running Secure Host MCP process").option("-f, --force", "force termination instead of requesting a graceful stop").action(async (options: { force?: boolean }) => {
  printServiceStatus(await new ServiceController(new ConfigStore()).stop(Boolean(options.force)));
});
program.command("status").description("Show whether Secure Host MCP is running").option("--json", "print machine-readable JSON").action(async (options: { json?: boolean }) => {
  const status = await new ServiceController(new ConfigStore()).status();
  if (options.json) console.log(JSON.stringify(status, null, 2));
  else printServiceStatus(status);
});
program.command("restart").description("Restart Secure Host MCP in the background").option("-f, --force", "force termination if the current process does not stop").action(async (options: { force?: boolean }) => {
  const store = new ConfigStore();
  await new ServiceController(store).stop(Boolean(options.force));
  await startInBackground(store);
});
program.command("launch", { hidden: true }).description("Initialize on first run, then start the servers").option("-d, --daemon", "run in the background").action(async (options: { daemon?: boolean }) => {
  const store = new ConfigStore();
  printSetupReport(store, await runInteractiveSetup(store));
  if (options.daemon) await startInBackground(store);
  else await runServer(store);
});
program.command("_serve", { hidden: true }).action(async () => runServer(new ConfigStore(), "daemon"));
program.command("helper").description("Start the local privileged helper (must already be root/SYSTEM)").action(async () => { const store = new ConfigStore(); const server = await startPrivilegeHelper(await store.loadConfig(), store); console.log("Privileged helper listening on 127.0.0.1:8769"); const stop = () => server.close(() => process.exit(0)); process.on("SIGINT", stop); process.on("SIGTERM", stop); });
program.command("doctor").description("Inspect configuration, coding workspace, and tunnel clients").action(async () => { const store = new ConfigStore(); const config = await store.loadConfig(); console.log(JSON.stringify({ configPath: store.configPath, publicBaseUrl: config.publicBaseUrl, coding: config.coding, tunnels: await new TunnelManager(config).inspect() }, null, 2)); });
program.command("tunnel").argument("<action>", "inspect|start|stop|install-plan|install").argument("[kind]", "cloudflared|frpc").option("--yes", "confirm installation from the official release").action(async (action: string, rawKind: string | undefined, options: { yes?: boolean }) => { const config = await new ConfigStore().loadConfig(); const tunnels = new TunnelManager(config); const kind = rawKind === "frpc" ? "frpc" : "cloudflared"; if (action === "inspect") console.log(JSON.stringify(await tunnels.inspect(), null, 2)); else if (action === "start") console.log(JSON.stringify(await tunnels.start(kind), null, 2)); else if (action === "stop") tunnels.stop(kind); else if (action === "install-plan") console.log(JSON.stringify(tunnels.installPlan(kind), null, 2)); else if (action === "install") console.log(JSON.stringify(await tunnels.install(kind, Boolean(options.yes)), null, 2)); else throw new Error(`Unknown action: ${action}`); });
await program.parseAsync();
