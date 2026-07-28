import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";

export interface AuditEvent {
  correlationId: string;
  action: string;
  principalId: string;
  success: boolean;
  command?: string;
  stdout?: string;
  stderr?: string;
  metadata?: Record<string, unknown>;
}

export class AuditLog {
  private queue = Promise.resolve();
  constructor(
    private readonly config: AppConfig,
    private readonly sensitiveValues: () => readonly string[] = () => []
  ) {}

  redact(value: string): string {
    let redacted = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
    const keys = this.config.audit.sensitiveKeys.map((key) => escapeRegExp(key)).join("|");
    if (keys) {
      const assignment = new RegExp(`\\b(${keys})\\b(\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;&]+)`, "gi");
      redacted = redacted.replace(assignment, (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`);
      const jsonValue = new RegExp(`(["'](?:${keys})["']\\s*:\\s*["'])([^"']+)(["'])`, "gi");
      redacted = redacted.replace(jsonValue, "$1[REDACTED]$3");
    }
    const literals = [...new Set(this.sensitiveValues().filter((item) => item.length >= 4))].sort((a, b) => b.length - a.length);
    for (const literal of literals) redacted = redacted.split(literal).join("[REDACTED]");
    return redacted;
  }

  write(event: AuditEvent): Promise<void> {
    const task = this.queue.then(async () => {
      const dir = path.join(this.config.dataDir, "audit");
      await mkdir(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      let file = path.join(dir, `${day}.jsonl`);
      try { if ((await stat(file)).size >= this.config.audit.maxFileBytes) file = path.join(dir, `${day}-${Date.now()}.jsonl`); } catch { /* new file */ }
      await appendFile(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...this.sanitize(event) })}\n`, { encoding: "utf8", mode: 0o600 });
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  async prune(): Promise<void> {
    const dir = path.join(this.config.dataDir, "audit");
    const cutoff = Date.now() - this.config.audit.retentionDays * 86400000;
    try {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isFile()) { const file = path.join(dir, entry.name); if ((await stat(file)).mtimeMs < cutoff) await unlink(file); }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private sanitize(event: AuditEvent): AuditEvent {
    const mode = this.config.audit.contentMode;
    const metadata = sanitizeMetadata(event.metadata, (value) => this.redact(value));
    if (mode === "metadata") {
      return {
        correlationId: event.correlationId,
        action: event.action,
        principalId: event.principalId,
        success: event.success,
        metadata: {
          ...metadata,
          commandBytes: event.command ? Buffer.byteLength(event.command) : 0,
          stdoutBytes: event.stdout ? Buffer.byteLength(event.stdout) : 0,
          stderrBytes: event.stderr ? Buffer.byteLength(event.stderr) : 0
        }
      };
    }
    if (mode === "full") return event;
    return {
      ...event,
      ...(event.command === undefined ? {} : { command: this.redact(event.command) }),
      ...(event.stdout === undefined ? {} : { stdout: this.redact(event.stdout) }),
      ...(event.stderr === undefined ? {} : { stderr: this.redact(event.stderr) }),
      ...(event.metadata === undefined ? {} : { metadata })
    };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeMetadata(value: Record<string, unknown> | undefined, redact: (value: string) => string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item, redact)]));
}

function sanitizeValue(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, redact));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeValue(item, redact)]));
  }
  return value;
}
