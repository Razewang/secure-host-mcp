import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import type { AppConfig } from "./config.js";
import { AppError, type CommandRequest, type CommandResult, type SystemInfo } from "./types.js";

interface Job { id: string; process: ChildProcessWithoutNullStreams; command: string; startedAt: number; stdout: string; stderr: string; offset: number; status: "running" | "completed" | "failed" | "cancelled"; exitCode: number | null; expiresAt: number; }

async function shellFor(config: AppConfig): Promise<{ command: string; args: string[] }> {
  if (config.execution.shell) return { command: config.execution.shell, args: process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command"] : ["-lc"] };
  if (process.platform === "win32") {
    try { await access("C:\\Program Files\\PowerShell\\7\\pwsh.exe"); return { command: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: ["-NoProfile", "-NonInteractive", "-Command"] }; } catch { return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command"] }; }
  }
  return { command: "/bin/bash", args: ["-lc"] };
}

function bounded(current: string, chunk: Buffer, max: number): { text: string; truncated: boolean } {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next) <= max) return { text: next, truncated: false };
  return { text: Buffer.from(next).subarray(0, max).toString("utf8"), truncated: true };
}

export class CommandExecutor {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly config: AppConfig) {}

  private async spawnCommand(request: CommandRequest): Promise<ChildProcessWithoutNullStreams> {
    if (!request.command.trim()) throw new AppError("EMPTY_COMMAND", "command must not be empty");
    const shell = await shellFor(this.config);
    return spawn(shell.command, [...shell.args, request.command], { cwd: request.cwd, env: { ...process.env, ...request.env }, detached: process.platform !== "win32", windowsHide: true, stdio: "pipe" });
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    const correlationId = randomUUID(); const started = Date.now(); const child = await this.spawnCommand(request);
    let stdout = "", stderr = "", truncated = false, timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => { const result = bounded(stdout, chunk, this.config.execution.maxOutputBytes); stdout = result.text; truncated ||= result.truncated; });
    child.stderr.on("data", (chunk: Buffer) => { const result = bounded(stderr, chunk, this.config.execution.maxOutputBytes); stderr = result.text; truncated ||= result.truncated; });
    const timeoutMs = Math.min(request.timeoutMs ?? 30000, this.config.execution.maxTimeoutMs);
    const timer = setTimeout(() => { timedOut = true; this.killProcess(child); }, timeoutMs);
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearTimeout(timer));
    return { correlationId, exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut, truncated };
  }

  async start(request: CommandRequest, onComplete?: (result: CommandResult) => void | Promise<void>): Promise<{ jobId: string; correlationId: string }> {
    this.cleanup();
    if (this.jobs.size >= this.config.execution.maxJobs) throw new AppError("JOB_LIMIT", "background job limit reached", 429);
    const process = await this.spawnCommand(request); const id = randomUUID();
    const job: Job = { id, process, command: request.command, startedAt: Date.now(), stdout: "", stderr: "", offset: 0, status: "running", exitCode: null, expiresAt: Date.now() + this.config.execution.jobTtlMs };
    process.stdout.on("data", (chunk: Buffer) => { job.stdout = bounded(job.stdout, chunk, this.config.execution.maxOutputBytes).text; });
    process.stderr.on("data", (chunk: Buffer) => { job.stderr = bounded(job.stderr, chunk, this.config.execution.maxOutputBytes).text; });
    process.once("error", () => { job.status = "failed"; });
    process.once("close", (code) => { job.exitCode = code; if (job.status === "running") job.status = code === 0 ? "completed" : "failed"; if (onComplete) void Promise.resolve(onComplete({ correlationId: id, exitCode: code, stdout: job.stdout, stderr: job.stderr, durationMs: Date.now() - job.startedAt, timedOut: false, truncated: Buffer.byteLength(job.stdout) >= this.config.execution.maxOutputBytes || Buffer.byteLength(job.stderr) >= this.config.execution.maxOutputBytes })).catch(() => undefined); });
    this.jobs.set(id, job); return { jobId: id, correlationId: id };
  }

  status(id: string): Record<string, unknown> { const job = this.requireJob(id); return { jobId: id, status: job.status, exitCode: job.exitCode, startedAt: new Date(job.startedAt).toISOString(), expiresAt: new Date(job.expiresAt).toISOString() }; }
  output(id: string, offset = 0): Record<string, unknown> { const job = this.requireJob(id); const combined = `STDOUT\n${job.stdout}\nSTDERR\n${job.stderr}`; const safeOffset = Math.max(0, Math.min(offset, combined.length)); return { jobId: id, offset: safeOffset, nextOffset: combined.length, data: combined.slice(safeOffset) }; }
  cancel(id: string): void { const job = this.requireJob(id); this.killProcess(job.process); job.status = "cancelled"; }
  private requireJob(id: string): Job { const job = this.jobs.get(id); if (!job) throw new AppError("JOB_NOT_FOUND", `unknown job: ${id}`, 404); return job; }
  private killProcess(child: ChildProcessWithoutNullStreams): void { try { if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); else if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGKILL"); } }
  private cleanup(): void { const now = Date.now(); for (const [id, job] of this.jobs) if (job.expiresAt < now && job.status !== "running") this.jobs.delete(id); }
  systemInfo(): SystemInfo {
    const cpus = os.cpus();
    return {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      release: os.release(),
      uptime: os.uptime(),
      cpus: cpus.length,
      cpuModel: cpus[0]?.model,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      node: process.version,
      uid: process.getuid?.(),
      elevated: isProcessElevated(),
      configuredAdminMode: this.config.adminMode
    };
  }
}

export function isProcessElevated(): boolean {
  if (process.platform !== "win32") return process.getuid?.() === 0;
  const check = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  return check.status === 0 && check.stdout.trim().toLowerCase() === "true";
}
