import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import * as nodePty from "node-pty";
import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import { resolveShell } from "./shell.js";
import { TerminalQueryResponder } from "./terminal-queries.js";
import { AppError } from "./types.js";
import {
  canAccessRuntime,
  type RuntimeAccess,
  type RuntimeRecord,
  type RuntimeRegistry
} from "./runtime.js";

interface TerminalSession {
  id: string;
  ownerId: string;
  pty: nodePty.IPty;
  shell: string;
  cwd: string;
  startedAt: number;
  lastActivityAt: number;
  expiresAt: number;
  status: "running" | "completed" | "failed" | "closed" | "expired" | "interrupted";
  exitCode: number | null;
  output: Buffer;
  startOffset: number;
  endOffset: number;
  cols: number;
  rows: number;
  queryResponder?: TerminalQueryResponder;
}

export interface CreateTerminalInput {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

let nodePtySpawnHelperReady: Promise<void> | undefined;

function ensureNodePtySpawnHelper(): Promise<void> {
  if (process.platform !== "darwin") return Promise.resolve();
  nodePtySpawnHelperReady ??= (async () => {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(require.resolve("node-pty/package.json"));
    const helper = path.join(packageRoot, "prebuilds", `darwin-${process.arch}`, "spawn-helper");
    try {
      await chmod(helper, 0o755);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  })();
  return nodePtySpawnHelperReady;
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly registry: RuntimeRegistry,
    private readonly audit: AuditLog
  ) {
    const interval = Math.min(1000, Math.max(50, Math.floor(config.execution.terminalIdleTtlMs / 4)));
    this.cleanupTimer = setInterval(() => this.expireIdle(), interval);
    this.cleanupTimer.unref();
  }

  async create(input: CreateTerminalInput, access: RuntimeAccess): Promise<Record<string, unknown>> {
    this.expireIdle();
    const active = [...this.sessions.values()].filter((session) => session.status === "running").length;
    if (active >= this.config.execution.maxTerminals) throw new AppError("TERMINAL_LIMIT", "terminal session limit reached", 429);
    const shell = await resolveShell(this.config, "interactive");
    const cwd = path.resolve(input.cwd ?? (this.config.coding.enabled ? this.config.coding.root! : process.cwd()));
    const cols = input.cols ?? 120;
    const rows = input.rows ?? 30;
    const id = randomUUID();
    const now = Date.now();
    await ensureNodePtySpawnHelper();
    const pty = nodePty.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, ...input.env },
      ...(process.platform === "win32" ? { useConpty: true, useConptyDll: true } : {})
    });
    const session: TerminalSession = {
      id,
      ownerId: access.principalId,
      pty,
      shell: shell.file,
      cwd,
      startedAt: now,
      lastActivityAt: now,
      expiresAt: now + this.config.execution.terminalIdleTtlMs,
      status: "running",
      exitCode: null,
      output: Buffer.alloc(0),
      startOffset: 0,
      endOffset: 0,
      cols,
      rows,
      ...(process.platform === "win32" ? { queryResponder: new TerminalQueryResponder() } : {})
    };
    pty.onData((data) => this.append(session, data));
    pty.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      if (session.status !== "running") {
        this.trimSessions();
        return;
      }
      session.status = exitCode === 0 ? "completed" : "failed";
      const endedAt = new Date().toISOString();
      void Promise.all([
        this.registry.update(id, { status: session.status, exitCode, endedAt }),
        this.audit.write({
          correlationId: id,
          action: "terminal.exit",
          principalId: session.ownerId,
          success: exitCode === 0,
          metadata: { terminalId: id, exitCode, status: session.status }
        })
      ]).catch(() => undefined);
      this.trimSessions();
    });
    this.sessions.set(id, session);
    const startedAt = new Date(now).toISOString();
    await this.registry.create({
      id,
      kind: "terminal",
      ownerId: access.principalId,
      status: "running",
      summary: shell.file,
      cwd,
      startedAt,
      expiresAt: new Date(session.expiresAt).toISOString(),
      cols,
      rows
    });
    await this.audit.write({
      correlationId: id,
      action: "terminal.create",
      principalId: access.principalId,
      success: true,
      metadata: { terminalId: id, cwd, shell: shell.file, cols, rows }
    });
    return this.describe(session, access);
  }

  read(id: string, offset: number, maxBytes: number | undefined, access: RuntimeAccess): Record<string, unknown> {
    const session = this.requireSession(id, access);
    this.touch(session);
    const maximum = maxBytes ?? this.config.execution.maxTerminalOutputBytes;
    const requestedOffset = Math.max(0, Math.floor(offset));
    const actualOffset = Math.max(requestedOffset, session.startOffset);
    const relative = Math.min(session.output.length, Math.max(0, actualOffset - session.startOffset));
    const length = Math.min(Math.max(1, maximum), session.output.length - relative);
    const selected = session.output.subarray(relative, relative + length);
    const data = selected.toString("utf8");
    return {
      ...this.describe(session, access),
      requestedOffset,
      startOffset: session.startOffset,
      offset: actualOffset,
      nextOffset: actualOffset + selected.length,
      endOffset: session.endOffset,
      droppedBytes: Math.max(0, session.startOffset - requestedOffset),
      data
    };
  }

  write(id: string, data: string, access: RuntimeAccess): Record<string, unknown> {
    const session = this.requireRunning(id, access);
    session.pty.write(data);
    this.touch(session);
    void this.audit.write({
      correlationId: id,
      action: "terminal.write",
      principalId: access.principalId,
      success: true,
      metadata: { terminalId: id, bytesWritten: Buffer.byteLength(data) }
    }).catch(() => undefined);
    return { terminalId: id, bytesWritten: Buffer.byteLength(data), expiresAt: new Date(session.expiresAt).toISOString() };
  }

  resize(id: string, cols: number, rows: number, access: RuntimeAccess): Record<string, unknown> {
    const session = this.requireRunning(id, access);
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    this.touch(session);
    void Promise.all([
      this.registry.update(id, { cols, rows, expiresAt: new Date(session.expiresAt).toISOString() }),
      this.audit.write({
        correlationId: id,
        action: "terminal.resize",
        principalId: access.principalId,
        success: true,
        metadata: { terminalId: id, cols, rows }
      })
    ]).catch(() => undefined);
    return { terminalId: id, cols, rows };
  }

  interrupt(id: string, access: RuntimeAccess): Record<string, unknown> {
    const session = this.requireRunning(id, access);
    session.pty.write("\u0003");
    this.touch(session);
    void this.audit.write({
      correlationId: id,
      action: "terminal.interrupt",
      principalId: access.principalId,
      success: true,
      metadata: { terminalId: id }
    }).catch(() => undefined);
    return { terminalId: id, interrupted: true };
  }

  close(id: string, access: RuntimeAccess, reason = "requested"): Record<string, unknown> {
    const session = this.requireSession(id, access);
    if (session.status === "running") {
      session.status = reason === "ttl" ? "expired" : reason === "server-shutdown" ? "interrupted" : "closed";
      session.pty.kill();
      const endedAt = new Date().toISOString();
      void Promise.all([
        this.registry.update(id, { status: session.status, endedAt, reason }),
        this.audit.write({
          correlationId: id,
          action: reason === "ttl" ? "terminal.expire" : "terminal.close",
          principalId: reason === "requested" ? access.principalId : session.ownerId,
          success: true,
          metadata: { terminalId: id, ownerId: session.ownerId, reason }
        })
      ]).catch(() => undefined);
    }
    return { terminalId: id, closed: true, status: session.status };
  }

  list(access: RuntimeAccess): RuntimeRecord[] {
    return this.registry.list(access).filter((record) => record.kind === "terminal");
  }

  async closeAll(): Promise<void> {
    clearInterval(this.cleanupTimer);
    const updates: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (session.status !== "running") continue;
      session.status = "interrupted";
      session.pty.kill();
      const endedAt = new Date().toISOString();
      updates.push(this.registry.update(session.id, { status: "interrupted", endedAt, reason: "server-shutdown" }));
      updates.push(this.audit.write({
        correlationId: session.id,
        action: "terminal.close",
        principalId: session.ownerId,
        success: true,
        metadata: { terminalId: session.id, ownerId: session.ownerId, reason: "server-shutdown" }
      }));
    }
    await Promise.all(updates);
  }

  private append(session: TerminalSession, data: string): void {
    for (const response of session.queryResponder?.push(data) ?? []) session.pty.write(response);
    const chunk = Buffer.from(data, "utf8");
    session.output = Buffer.concat([session.output, chunk]);
    session.endOffset += chunk.length;
    const overflow = session.output.length - this.config.execution.maxTerminalOutputBytes;
    if (overflow > 0) {
      session.output = session.output.subarray(overflow);
      session.startOffset += overflow;
    }
    this.touch(session);
  }

  private touch(session: TerminalSession): void {
    session.lastActivityAt = Date.now();
    session.expiresAt = session.lastActivityAt + this.config.execution.terminalIdleTtlMs;
  }

  private expireIdle(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.status === "running" && session.expiresAt <= now) {
        this.close(session.id, { principalId: session.ownerId, canManageAll: false }, "ttl");
      }
    }
  }

  private trimSessions(): void {
    const completed = [...this.sessions.values()]
      .filter((session) => session.status !== "running")
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const excess = Math.max(0, completed.length - this.config.execution.runtimeHistoryLimit);
    for (const session of completed.slice(completed.length - excess)) this.sessions.delete(session.id);
  }

  private requireSession(id: string, access: RuntimeAccess): TerminalSession {
    const session = this.sessions.get(id);
    if (!session || !canAccessRuntime(session.ownerId, access)) throw new AppError("TERMINAL_NOT_FOUND", `unknown terminal: ${id}`, 404);
    return session;
  }

  private requireRunning(id: string, access: RuntimeAccess): TerminalSession {
    const session = this.requireSession(id, access);
    if (session.status !== "running") throw new AppError("TERMINAL_CLOSED", `terminal is not running: ${id}`, 409);
    return session;
  }

  private describe(session: TerminalSession, access: RuntimeAccess): Record<string, unknown> {
    return {
      terminalId: session.id,
      status: session.status,
      shell: session.shell,
      cwd: session.cwd,
      startedAt: new Date(session.startedAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      exitCode: session.exitCode,
      cols: session.cols,
      rows: session.rows,
      ...(access.canManageAll ? { ownerId: session.ownerId } : {})
    };
  }
}
