import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/audit.js";
import { ConfigStore } from "../src/config.js";
import { RuntimeRegistry, type RuntimeAccess } from "../src/runtime.js";
import { TerminalManager } from "../src/terminal.js";

const dirs: string[] = [];
const managers: TerminalManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function fixture(outputBytes = 1024 * 1024, ttlMs = 30_000): Promise<{ dir: string; registry: RuntimeRegistry; manager: TerminalManager; owner: RuntimeAccess; other: RuntimeAccess; admin: RuntimeAccess }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-terminal-"));
  dirs.push(dir);
  const config = await new ConfigStore(dir).loadConfig();
  await mkdir(config.coding.root!, { recursive: true });
  config.execution.maxTerminalOutputBytes = outputBytes;
  config.execution.terminalIdleTtlMs = ttlMs;
  const audit = new AuditLog(config);
  const registry = new RuntimeRegistry(config, (value) => audit.redact(value));
  await registry.initialize();
  const manager = new TerminalManager(config, registry, audit);
  managers.push(manager);
  return {
    dir,
    registry,
    manager,
    owner: { principalId: "owner-a", canManageAll: false },
    other: { principalId: "owner-b", canManageAll: false },
    admin: { principalId: "admin", canManageAll: true }
  };
}

async function waitForMarker(
  manager: TerminalManager,
  id: string,
  marker: string,
  access: RuntimeAccess,
  requiredFragment?: string,
  attempts = 100
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = manager.read(id, 0, undefined, access);
    const data = String(last.data);
    if (data.includes(marker) && (!requiredFragment || data.includes(requiredFragment))) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`terminal marker not observed: ${marker}; last=${JSON.stringify(last)}`);
}

async function writeUntilMarker(
  manager: TerminalManager,
  id: string,
  command: string,
  marker: string,
  access: RuntimeAccess
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    manager.write(id, command, access);
    try {
      return await waitForMarker(manager, id, marker, access, undefined, 40);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("TerminalManager", () => {
  it("supports PTY input, output, resize, owner isolation, and administrator access", { timeout: 15_000 }, async () => {
    const { manager, owner, other, admin } = await fixture();
    const created = await manager.create({ cols: 80, rows: 24 }, owner);
    const id = String(created.terminalId);
    expect(() => manager.read(id, 0, undefined, other)).toThrow("unknown terminal");
    expect(manager.read(id, 0, undefined, admin).ownerId).toBe("owner-a");
    expect(manager.resize(id, 100, 40, owner)).toMatchObject({ cols: 100, rows: 40 });

    const command = process.platform === "win32"
      ? "Write-Output \"`e[31msecure-host-terminal-marker`e[0m\"\r"
      : "printf '\\033[31msecure-host-terminal-marker\\033[0m\\n'\n";
    manager.write(id, command, owner);
    const markerOutput = String((await waitForMarker(manager, id, "secure-host-terminal-marker", owner, "\u001b[")).data);
    expect(markerOutput).toContain("secure-host-terminal-marker");
    expect(markerOutput).toContain("\u001b[");

    manager.write(id, process.platform === "win32" ? "Start-Sleep -Seconds 30\r" : "sleep 30\n", owner);
    await new Promise((resolve) => setTimeout(resolve, 200));
    manager.interrupt(id, owner);
    const afterInterrupt = await writeUntilMarker(
      manager,
      id,
      process.platform === "win32"
        ? "Write-Output (\"secure-host-after-\" + \"interrupt\")\r"
        : "printf 'secure-host-after-%s\\n' 'interrupt'\n",
      "secure-host-after-interrupt",
      owner
    );
    expect(String(afterInterrupt.data)).toContain("secure-host-after-interrupt");
    expect(manager.close(id, owner)).toMatchObject({ closed: true, status: "closed" });
  });

  it("reports output loss through monotonic byte cursors", { timeout: 15_000 }, async () => {
    const { manager, owner } = await fixture(64);
    const created = await manager.create({}, owner);
    const id = String(created.terminalId);
    const command = process.platform === "win32"
      ? "Write-Output ('x' * 512)\r"
      : "printf '%0512d\\n' 0\n";
    manager.write(id, command, owner);
    let result: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      result = manager.read(id, 0, undefined, owner);
      if (Number(result.droppedBytes) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(Number(result.startOffset)).toBeGreaterThan(0);
    expect(result.offset).toBe(result.startOffset);
    expect(result.droppedBytes).toBe(result.startOffset);
    expect(Number(result.nextOffset)).toBeLessThanOrEqual(Number(result.endOffset));
  });

  it("expires idle terminals", { timeout: 15_000 }, async () => {
    const { manager, owner } = await fixture(1024, 100);
    const created = await manager.create({}, owner);
    const id = String(created.terminalId);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(manager.read(id, 0, undefined, owner).status).toBe("expired");
  });

  it("audits lifecycle and byte counts without storing terminal input", { timeout: 15_000 }, async () => {
    const { dir, manager, owner } = await fixture();
    const created = await manager.create({}, owner);
    const id = String(created.terminalId);
    manager.write(id, "password=terminal-input-must-not-be-logged\r", owner);
    manager.resize(id, 90, 25, owner);
    manager.interrupt(id, owner);
    manager.close(id, owner);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const auditDir = path.join(dir, "audit");
    const files = await readdir(auditDir);
    const content = (await Promise.all(files.map((file) => readFile(path.join(auditDir, file), "utf8")))).join("");
    expect(content).toContain("terminal.create");
    expect(content).toContain("terminal.write");
    expect(content).toContain("bytesWritten");
    expect(content).toContain("terminal.resize");
    expect(content).toContain("terminal.interrupt");
    expect(content).toContain("terminal.close");
    expect(content).not.toContain("terminal-input-must-not-be-logged");
  });

  it("keeps polling and input activity off the persistent-state hot path", async () => {
    const { manager, registry, owner } = await fixture();
    const created = await manager.create({}, owner);
    const id = String(created.terminalId);
    const update = vi.spyOn(registry, "update");
    manager.read(id, 0, undefined, owner);
    manager.write(id, "", owner);
    manager.interrupt(id, owner);
    expect(update).not.toHaveBeenCalled();
    manager.resize(id, 100, 40, owner);
    expect(update).toHaveBeenCalledOnce();
  });
});
