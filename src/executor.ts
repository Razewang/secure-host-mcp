import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnSync } from "node:child_process";
import os from "node:os";
import type { AppConfig } from "./config.js";
import { resolveShell } from "./shell.js";
import { AppError, type CommandRequest, type CommandResult, type SystemInfo } from "./types.js";
import {
  canAccessRuntime,
  type RuntimeAccess,
  type RuntimeRecord,
  type RuntimeRegistry
} from "./runtime.js";

interface Job { id: string; ownerId: string; process: ChildProcessWithoutNullStreams; command: string; cwd?: string; startedAt: number; stdout: string; stderr: string; offset: number; status: "running" | "completed" | "failed" | "cancelled" | "interrupted"; exitCode: number | null; expiresAt: number; }

function bounded(current: string, chunk: Buffer, max: number): { text: string; truncated: boolean } {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next) <= max) return { text: next, truncated: false };
  return { text: Buffer.from(next).subarray(0, max).toString("utf8"), truncated: true };
}

export class CommandExecutor {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly config: AppConfig, private readonly registry?: RuntimeRegistry) {}

  private async spawnCommand(request: CommandRequest): Promise<ChildProcessWithoutNullStreams> {
    if (!request.command.trim()) throw new AppError("EMPTY_COMMAND", "command must not be empty");
    const shell = await resolveShell(this.config, "batch");
    return spawn(shell.file, [...shell.args, request.command], { cwd: request.cwd, env: { ...process.env, ...request.env }, detached: process.platform !== "win32", windowsHide: true, stdio: "pipe" });
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

  async start(request: CommandRequest, onComplete: ((result: CommandResult) => void | Promise<void>) | undefined, access: RuntimeAccess): Promise<{ jobId: string; correlationId: string }> {
    this.cleanup();
    if (this.jobs.size >= this.config.execution.maxJobs) throw new AppError("JOB_LIMIT", "background job limit reached", 429);
    const process = await this.spawnCommand(request); const id = randomUUID();
    const job: Job = { id, ownerId: access.principalId, process, command: request.command, ...(request.cwd ? { cwd: request.cwd } : {}), startedAt: Date.now(), stdout: "", stderr: "", offset: 0, status: "running", exitCode: null, expiresAt: Date.now() + this.config.execution.jobTtlMs };
    const startedAt = new Date(job.startedAt).toISOString();
    const registryReady = this.registry?.create({
      id,
      kind: "job",
      ownerId: access.principalId,
      status: "running",
      summary: request.command,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      startedAt,
      expiresAt: new Date(job.expiresAt).toISOString()
    }) ?? Promise.resolve();
    process.stdout.on("data", (chunk: Buffer) => { job.stdout = bounded(job.stdout, chunk, this.config.execution.maxOutputBytes).text; });
    process.stderr.on("data", (chunk: Buffer) => { job.stderr = bounded(job.stderr, chunk, this.config.execution.maxOutputBytes).text; });
    process.once("error", () => { job.status = "failed"; void registryReady.then(() => this.registry?.update(id, { status: "failed", endedAt: new Date().toISOString(), reason: "spawn-error" })).catch(() => undefined); });
    process.once("close", (code) => {
      job.exitCode = code;
      if (job.status === "running") job.status = code === 0 ? "completed" : "failed";
      void registryReady.then(() => this.registry?.update(id, { status: job.status, exitCode: code, endedAt: new Date().toISOString() })).catch(() => undefined);
      if (onComplete) void Promise.resolve(onComplete({ correlationId: id, exitCode: code, stdout: job.stdout, stderr: job.stderr, durationMs: Date.now() - job.startedAt, timedOut: false, truncated: Buffer.byteLength(job.stdout) >= this.config.execution.maxOutputBytes || Buffer.byteLength(job.stderr) >= this.config.execution.maxOutputBytes })).catch(() => undefined);
    });
    this.jobs.set(id, job);
    await registryReady;
    return { jobId: id, correlationId: id };
  }

  status(id: string, access: RuntimeAccess): Record<string, unknown> {
    const job = this.requireJob(id, access);
    return { jobId: id, status: job.status, exitCode: job.exitCode, startedAt: new Date(job.startedAt).toISOString(), expiresAt: new Date(job.expiresAt).toISOString(), ...(access.canManageAll ? { ownerId: job.ownerId } : {}) };
  }
  output(id: string, offset: number, access: RuntimeAccess): Record<string, unknown> { const job = this.requireJob(id, access); const combined = `STDOUT\n${job.stdout}\nSTDERR\n${job.stderr}`; const safeOffset = Math.max(0, Math.min(offset, combined.length)); return { jobId: id, offset: safeOffset, nextOffset: combined.length, data: combined.slice(safeOffset) }; }
  async writeInput(id: string, data: string, close: boolean, access: RuntimeAccess): Promise<Record<string, unknown>> {
    const job = this.requireJob(id, access);
    if (job.status !== "running" || job.process.stdin.destroyed) throw new AppError("JOB_STDIN_CLOSED", `stdin is closed for job: ${id}`, 409);
    if (data) {
      await new Promise<void>((resolve, reject) => {
        job.process.stdin.write(data, "utf8", (error) => error ? reject(error) : resolve());
      });
    }
    if (close) job.process.stdin.end();
    return { jobId: id, bytesWritten: Buffer.byteLength(data), stdinClosed: close };
  }
  cancel(id: string, access: RuntimeAccess): void {
    const job = this.requireJob(id, access);
    this.killProcess(job.process);
    job.status = "cancelled";
    void this.registry?.update(id, { status: "cancelled", endedAt: new Date().toISOString(), reason: "requested" }).catch(() => undefined);
  }
  list(access: RuntimeAccess): RuntimeRecord[] {
    return this.registry?.list(access).filter((record) => record.kind === "job") ?? [];
  }
  async closeAll(): Promise<void> {
    const updates: Promise<void>[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        this.killProcess(job.process);
        job.status = "interrupted";
        if (this.registry) updates.push(this.registry.update(job.id, { status: "interrupted", endedAt: new Date().toISOString(), reason: "server-shutdown" }));
      }
    }
    await Promise.all(updates);
  }
  private requireJob(id: string, access: RuntimeAccess): Job { const job = this.jobs.get(id); if (!job || !canAccessRuntime(job.ownerId, access)) throw new AppError("JOB_NOT_FOUND", `unknown job: ${id}`, 404); return job; }
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
