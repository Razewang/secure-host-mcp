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
  constructor(private readonly config: AppConfig) {}

  write(event: AuditEvent): Promise<void> {
    const task = this.queue.then(async () => {
      const dir = path.join(this.config.dataDir, "audit");
      await mkdir(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      let file = path.join(dir, `${day}.jsonl`);
      try { if ((await stat(file)).size >= this.config.audit.maxFileBytes) file = path.join(dir, `${day}-${Date.now()}.jsonl`); } catch { /* new file */ }
      await appendFile(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, { encoding: "utf8", mode: 0o600 });
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
}
