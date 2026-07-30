import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.js";
import { ServiceController, type SpawnOptions } from "../src/service.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStore(): Promise<ConfigStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-service-"));
  dirs.push(dir);
  return new ConfigStore(dir);
}

describe("ServiceController", () => {
  it("records running state and rejects duplicate starts", async () => {
    const store = await createStore();
    const controller = new ServiceController(store, {
      isProcessRunning: (pid) => pid === 321,
      now: () => new Date("2026-07-30T00:00:00.000Z")
    });
    await controller.recordRunning("daemon", 321);

    await expect(controller.status()).resolves.toMatchObject({
      status: "running",
      pid: 321,
      mode: "daemon",
      startedAt: "2026-07-30T00:00:00.000Z",
      logPath: controller.logPath
    });
    await expect(controller.assertStopped()).rejects.toThrow("already running with PID 321");
  });

  it("removes stale state without signalling an unrelated process", async () => {
    const store = await createStore();
    const signalProcess = vi.fn();
    const controller = new ServiceController(store, {
      isProcessRunning: () => false,
      signalProcess
    });
    await controller.recordRunning("foreground", 654);

    await expect(controller.status()).resolves.toMatchObject({ status: "stopped", stalePid: 654 });
    await expect(readFile(controller.statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(signalProcess).not.toHaveBeenCalled();
  });

  it("requests graceful termination and waits for the process to exit", async () => {
    const store = await createStore();
    let running = true;
    const signalProcess = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      expect(signal).toBe("SIGTERM");
      running = false;
    });
    const controller = new ServiceController(store, {
      isProcessRunning: () => running,
      signalProcess,
      sleep: async () => undefined
    });
    await controller.recordRunning("foreground", 777);

    await expect(controller.stop()).resolves.toMatchObject({ status: "stopped" });
    expect(signalProcess).toHaveBeenCalledWith(777, "SIGTERM");
  });

  it("starts a detached child and waits for its matching ready state", async () => {
    const store = await createStore();
    let spawned: SpawnOptions | undefined;
    let stateWrite = Promise.resolve();
    const unref = vi.fn();
    const child = { pid: 888, unref } as unknown as ChildProcess;
    const controller = new ServiceController(store, {
      isProcessRunning: (pid) => pid === 888,
      spawnDetached: (options) => {
        spawned = options;
        stateWrite = controller.recordRunning("daemon", 888).then(() => undefined);
        return child;
      },
      sleep: async () => stateWrite
    });

    await expect(controller.startDaemon("C:\\app\\cli.js", "C:\\workspace")).resolves.toMatchObject({
      status: "running",
      pid: 888,
      mode: "daemon"
    });
    expect(spawned).toMatchObject({
      command: process.execPath,
      args: ["C:\\app\\cli.js", "_serve"],
      cwd: "C:\\workspace"
    });
    expect(spawned?.env.SECURE_HOST_MCP_HOME).toBe(store.dataDir);
    expect(unref).toHaveBeenCalledOnce();
  });
});
