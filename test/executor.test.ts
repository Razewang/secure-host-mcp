import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { CommandExecutor } from "../src/executor.js";

const dirs: string[] = [];
const PROCESS_TEST_TIMEOUT_MS = 15000;
const localAccess = { principalId: "test-owner", canManageAll: true };
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function executor(): Promise<CommandExecutor> { const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const config = await new ConfigStore(dir).loadConfig(); return new CommandExecutor(config); }

describe("CommandExecutor", () => {
  it("captures stdout, stderr, and exit code", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    const run = await executor(); const command = process.platform === "win32" ? "Write-Output hello; [Console]::Error.WriteLine('problem'); exit 7" : "echo hello; echo problem >&2; exit 7";
    const result = await run.execute({ command }); expect(result.exitCode).toBe(7); expect(result.stdout).toContain("hello"); expect(result.stderr).toContain("problem");
  });
  it("tracks and cancels a background job", async () => {
    const run = await executor(); const command = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30"; const job = await run.start({ command }, undefined, localAccess); expect(run.status(job.jobId, localAccess).status).toBe("running"); run.cancel(job.jobId, localAccess); expect(run.status(job.jobId, localAccess).status).toBe("cancelled");
  });
  it("hides jobs from other owners while allowing administrators", async () => {
    const run = await executor();
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";
    const owner = { principalId: "owner-a", canManageAll: false };
    const job = await run.start({ command }, undefined, owner);
    expect(() => run.status(job.jobId, { principalId: "owner-b", canManageAll: false })).toThrow("unknown job");
    expect(run.status(job.jobId, { principalId: "admin", canManageAll: true })).toMatchObject({ ownerId: "owner-a" });
    run.cancel(job.jobId, owner);
  });
  it("writes input to an interactive background job", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
    const run = await executor();
    const command = process.platform === "win32"
      ? "$line = [Console]::In.ReadLine(); Write-Output \"got:$line\""
      : "IFS= read -r line; printf 'got:%s\\n' \"$line\"";
    const job = await run.start({ command }, undefined, localAccess);
    await run.writeInput(job.jobId, "hello\n", true, localAccess);
    for (let attempt = 0; attempt < 100 && run.status(job.jobId, localAccess).status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(String(run.output(job.jobId, 0, localAccess).data)).toContain("got:hello");
    await expect(run.writeInput(job.jobId, "again", false, localAccess)).rejects.toThrow("stdin is closed");
  });
});
