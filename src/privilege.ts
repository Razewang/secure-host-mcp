import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { spawn } from "node:child_process";
import type { AppConfig, ConfigStore } from "./config.js";
import { CommandExecutor, isProcessElevated } from "./executor.js";
import { AppError, type CommandRequest, type CommandResult } from "./types.js";
import { AuditLog } from "./audit.js";

function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }

export class PrivilegeClient {
  constructor(private readonly config: AppConfig, private readonly store: ConfigStore) { void config; }
  async execute(command: CommandRequest): Promise<CommandResult> {
    const key = await this.store.ensureHelperKey(); const body = JSON.stringify(command);
    return await new Promise<CommandResult>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: 8769, path: "/execute", method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
        const chunks: Buffer[] = []; res.on("data", (chunk: Buffer) => chunks.push(chunk)); res.on("end", () => { try { const parsed = JSON.parse(Buffer.concat(chunks).toString()) as CommandResult & { error?: string }; if ((res.statusCode ?? 500) >= 400) reject(new AppError("HELPER_ERROR", parsed.error ?? "privileged helper rejected request", res.statusCode)); else resolve(parsed); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); } });
      });
      req.once("error", () => reject(new AppError("HELPER_UNAVAILABLE", "Privileged helper is not running on 127.0.0.1:8769", 503))); req.setTimeout(5000, () => req.destroy(new Error("helper connection timed out"))); req.end(body);
    });
  }
  async restartAsAdministrator(): Promise<void> {
    const key = await this.store.ensureHelperKey(); const body = JSON.stringify({ pid: process.pid, entry: process.argv[1] });
    await new Promise<void>((resolve, reject) => { const req = httpRequest({ host: "127.0.0.1", port: 8769, path: "/restart-admin", method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => { res.resume(); res.on("end", () => (res.statusCode === 202 ? resolve() : reject(new AppError("HELPER_ERROR", "helper rejected administrator restart", res.statusCode)))); }); req.once("error", () => reject(new AppError("HELPER_UNAVAILABLE", "Privileged helper is not running", 503))); req.end(body); });
  }
}

export async function startPrivilegeHelper(config: AppConfig, store: ConfigStore): Promise<Server> {
  if (!isProcessElevated()) throw new AppError("HELPER_NOT_PRIVILEGED", process.platform === "win32" ? "Start the helper from an elevated Administrator terminal" : "The helper must run as root", 403);
  const key = await store.ensureHelperKey(); const executor = new CommandExecutor({ ...config, adminMode: true }); const audit = new AuditLog(config);
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !["/execute", "/restart-admin"].includes(req.url ?? "") || !safeEqual(req.headers.authorization ?? "", `Bearer ${key}`)) { res.writeHead(401).end(JSON.stringify({ error: "unauthorized" })); return; }
    const chunks: Buffer[] = []; let size = 0;
    req.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) req.destroy(); else chunks.push(chunk); });
    req.on("end", () => { void (async () => { try {
      if (req.url === "/restart-admin") {
        const input = JSON.parse(Buffer.concat(chunks).toString()) as { pid?: number; entry?: string }; if (!Number.isInteger(input.pid) || !input.entry) throw new AppError("INVALID_RESTART", "pid and entry are required"); const nextConfig = await store.loadConfig(); nextConfig.adminMode = true; await store.saveConfig(nextConfig); await audit.write({ correlationId: String(input.pid), action: "helper.restart-admin", principalId: "local-helper-client", success: true, metadata: { entry: input.entry } }); res.writeHead(202).end(); setTimeout(() => { try { process.kill(input.pid!, "SIGTERM"); } catch { /* already stopped */ } setTimeout(() => { const child = spawn(process.execPath, [input.entry!, "start"], { detached: true, stdio: "ignore", env: process.env, windowsHide: true }); child.unref(); }, 750); }, 500); return;
      }
      const input = JSON.parse(Buffer.concat(chunks).toString()) as CommandRequest; const result = await executor.execute(input); await audit.write({ correlationId: result.correlationId, action: "helper.execute", principalId: "local-helper-client", success: result.exitCode === 0, command: input.command, stdout: result.stdout, stderr: result.stderr }); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); } })(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(8769, "127.0.0.1", resolve); }); return server;
}
