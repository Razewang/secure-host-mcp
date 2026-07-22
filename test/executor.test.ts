import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { CommandExecutor } from "../src/executor.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function executor(): Promise<CommandExecutor> { const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const config = await new ConfigStore(dir).loadConfig(); return new CommandExecutor(config); }

describe("CommandExecutor", () => {
  it("captures stdout, stderr, and exit code", async () => {
    const run = await executor(); const command = process.platform === "win32" ? "Write-Output hello; [Console]::Error.WriteLine('problem'); exit 7" : "echo hello; echo problem >&2; exit 7";
    const result = await run.execute({ command }); expect(result.exitCode).toBe(7); expect(result.stdout).toContain("hello"); expect(result.stderr).toContain("problem");
  });
  it("tracks and cancels a background job", async () => {
    const run = await executor(); const command = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30"; const job = await run.start({ command }); expect(run.status(job.jobId).status).toBe("running"); run.cancel(job.jobId); expect(run.status(job.jobId).status).toBe("cancelled");
  });
});
