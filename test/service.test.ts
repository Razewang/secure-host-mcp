import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.js";
import { atomicWriteJson } from "../src/files.js";
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
      getProcessIdentity: (pid) => pid === 321 ? "test:321:started" : undefined,
      now: () => new Date("2026-07-30T00:00:00.000Z")
    });
    await controller.recordRunning("daemon", 321);

    await expect(controller.status()).resolves.toMatchObject({
      status: "running",
      pid: 321,
      processIdentity: "test:321:started",
      mode: "daemon",
      startedAt: "2026-07-30T00:00:00.000Z",
      logPath: controller.logPath
    });
    await expect(controller.assertStopped()).rejects.toThrow("already running with PID 321");
  });

  it("removes stale state without signalling an unrelated process", async () => {
    const store = await createStore();
    let running = true;
    const signalProcess = vi.fn();
    const controller = new ServiceController(store, {
      isProcessRunning: () => running,
      getProcessIdentity: () => running ? "test:654:started" : undefined,
      signalProcess
    });
    await controller.recordRunning("foreground", 654);
    running = false;

    await expect(controller.status()).resolves.toMatchObject({ status: "stopped", stalePid: 654 });
    await expect(readFile(controller.statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(signalProcess).not.toHaveBeenCalled();
  });

  it("treats a reused PID as stale and never signals the new process", async () => {
    const store = await createStore();
    let identity = "test:654:original";
    const signalProcess = vi.fn();
    const controller = new ServiceController(store, {
      isProcessRunning: () => true,
      getProcessIdentity: () => identity,
      signalProcess
    });
    await controller.recordRunning("foreground", 654);
    identity = "test:654:reused";

    await expect(controller.stop()).resolves.toMatchObject({ status: "stopped", stalePid: 654 });
    await expect(readFile(controller.statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(signalProcess).not.toHaveBeenCalled();
  });

  it("rechecks identity immediately before sending a signal", async () => {
    const store = await createStore();
    let identityChecks = 0;
    const signalProcess = vi.fn();
    const controller = new ServiceController(store, {
      isProcessRunning: () => true,
      getProcessIdentity: () => {
        identityChecks += 1;
        return identityChecks < 3 ? "test:654:original" : "test:654:reused";
      },
      signalProcess
    });
    await controller.recordRunning("foreground", 654);

    await expect(controller.stop()).resolves.toMatchObject({ status: "stopped", stalePid: 654 });
    expect(signalProcess).not.toHaveBeenCalled();
  });

  it("safely removes legacy state that cannot prove process identity", async () => {
    const store = await createStore();
    const signalProcess = vi.fn();
    const controller = new ServiceController(store, {
      isProcessRunning: () => true,
      getProcessIdentity: () => "test:654:unrelated",
      signalProcess
    });
    await controller.recordRunning("foreground", 654);
    const state = JSON.parse(await readFile(controller.statePath, "utf8")) as Record<string, unknown>;
    delete state.processIdentity;
    state.version = 1;
    await atomicWriteJson(controller.statePath, state, true);

    await expect(controller.stop()).resolves.toMatchObject({ status: "stopped", stalePid: 654 });
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
      getProcessIdentity: () => running ? "test:777:started" : undefined,
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
      getProcessIdentity: (pid) => pid === 888 ? "test:888:started" : undefined,
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
