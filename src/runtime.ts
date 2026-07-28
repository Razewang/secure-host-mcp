import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { atomicWriteJson } from "./files.js";
import { AppError } from "./types.js";

export interface RuntimeAccess {
  principalId: string;
  canManageAll: boolean;
}

const RuntimeStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
  "closed",
  "expired",
  "interrupted"
]);

const RuntimeRecordSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["job", "terminal"]),
  ownerId: z.string().min(1),
  status: RuntimeStatusSchema,
  summary: z.string(),
  cwd: z.string().optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  exitCode: z.number().int().nullable().optional(),
  reason: z.string().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional()
});

const RuntimeStateSchema = z.object({
  version: z.literal(1),
  records: z.array(RuntimeRecordSchema)
});

export type RuntimeRecord = z.infer<typeof RuntimeRecordSchema>;

export class RuntimeRegistry {
  private readonly records = new Map<string, RuntimeRecord>();
  readonly file: string;

  constructor(
    private readonly config: AppConfig,
    private readonly redact: (value: string) => string
  ) {
    this.file = path.join(config.dataDir, "runtime-state.json");
  }

  async initialize(): Promise<void> {
    let parsed: z.infer<typeof RuntimeStateSchema>;
    try {
      parsed = RuntimeStateSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new AppError("RUNTIME_STATE_INVALID", `runtime state is invalid at ${this.file}`, 500);
      }
      throw error;
    }
    const now = new Date().toISOString();
    let changed = false;
    for (const record of parsed.records) {
      if (record.status === "running") {
        record.status = "interrupted";
        record.reason = "server-restarted";
        record.endedAt = now;
        record.updatedAt = now;
        changed = true;
      }
      this.records.set(record.id, record);
    }
    this.trim();
    if (changed) await this.persist();
  }

  async create(input: Omit<RuntimeRecord, "summary" | "updatedAt"> & { summary: string }): Promise<void> {
    const record = RuntimeRecordSchema.parse({
      ...input,
      summary: this.redact(input.summary),
      ...(input.cwd === undefined ? {} : { cwd: this.redact(input.cwd) }),
      updatedAt: input.startedAt
    });
    this.records.set(record.id, record);
    this.trim();
    await this.persist();
  }

  update(id: string, patch: Partial<Omit<RuntimeRecord, "id" | "kind" | "ownerId" | "startedAt">>): Promise<void> {
    const current = this.records.get(id);
    if (!current) return Promise.resolve();
    const next = RuntimeRecordSchema.parse({
      ...current,
      ...patch,
      ...(patch.summary === undefined ? {} : { summary: this.redact(patch.summary) }),
      ...(patch.cwd === undefined ? {} : { cwd: this.redact(patch.cwd) }),
      updatedAt: new Date().toISOString()
    });
    this.records.set(id, next);
    this.trim();
    return this.persist();
  }

  list(access: RuntimeAccess): RuntimeRecord[] {
    return [...this.records.values()]
      .filter((record) => access.canManageAll || record.ownerId === access.principalId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((record) => ({ ...record }));
  }

  private trim(): void {
    const sorted = [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const running = sorted.filter((record) => record.status === "running");
    const history = sorted
      .filter((record) => record.status !== "running")
      .slice(0, Math.max(0, this.config.execution.runtimeHistoryLimit - running.length));
    const keep = new Set([...running, ...history].map((record) => record.id));
    for (const id of this.records.keys()) if (!keep.has(id)) this.records.delete(id);
  }

  private persist(): Promise<void> {
    return atomicWriteJson(
      this.file,
      { version: 1, records: [...this.records.values()] },
      true
    );
  }
}

export function canAccessRuntime(ownerId: string, access: RuntimeAccess): boolean {
  return access.canManageAll || ownerId === access.principalId;
}
