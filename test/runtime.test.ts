import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { RuntimeRegistry } from "../src/runtime.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("RuntimeRegistry", () => {
  it("isolates summaries by owner and marks running records interrupted after restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-runtime-"));
    dirs.push(dir);
    const config = await new ConfigStore(dir).loadConfig();
    const first = new RuntimeRegistry(config, (value) => value.replace("private-value", "[REDACTED]"));
    const startedAt = new Date().toISOString();
    await first.create({
      id: "0b4ec080-971e-4d8f-9ebf-7445dfad62ed",
      kind: "terminal",
      ownerId: "owner-a",
      status: "running",
      summary: "private-value",
      startedAt
    });

    expect(first.list({ principalId: "owner-b", canManageAll: false })).toEqual([]);
    expect(first.list({ principalId: "owner-a", canManageAll: false })[0]?.summary).toBe("[REDACTED]");

    const restored = new RuntimeRegistry(config, (value) => value);
    await restored.initialize();
    const [record] = restored.list({ principalId: "admin", canManageAll: true });
    expect(record).toMatchObject({ status: "interrupted", reason: "server-restarted", ownerId: "owner-a" });
    const persisted = JSON.parse(await readFile(restored.file, "utf8")) as { records: Array<{ status: string }> };
    expect(persisted.records[0]?.status).toBe("interrupted");
  });
});
