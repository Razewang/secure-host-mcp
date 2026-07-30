import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import type { ConfigStore } from "./config.js";
import { atomicWriteJson } from "./files.js";
import { AppError } from "./types.js";

const ServiceStateFields = {
  pid: z.number().int().positive(),
  mode: z.enum(["foreground", "daemon"]),
  startedAt: z.string().datetime(),
  logPath: z.string().optional()
};

const LegacyServiceStateSchema = z.object({
  version: z.literal(1),
  ...ServiceStateFields
});

const ServiceStateSchema = z.object({
  version: z.literal(2),
  ...ServiceStateFields,
  processIdentity: z.string().min(1)
});

type StoredServiceState = z.infer<typeof LegacyServiceStateSchema> | ServiceState;
export type ServiceState = z.infer<typeof ServiceStateSchema>;

export type ServiceStatus =
  | { status: "stopped"; statePath: string; logPath: string; stalePid?: number }
  | ({ status: "running"; statePath: string } & ServiceState);

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutFd: number;
  stderrFd: number;
}

export interface ServiceDependencies {
  isProcessRunning(pid: number): boolean;
  getProcessIdentity(pid: number): string | undefined;
  signalProcess(pid: number, signal: NodeJS.Signals): void;
  spawnDetached(options: SpawnOptions): ChildProcess;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processIdentity(pid: number): string | undefined {
  if (!processRunning(pid)) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      const startTime = fieldsAfterCommand[19];
      return startTime ? `linux:${startTime}` : undefined;
    }
    if (process.platform === "win32") {
      const ticks = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
      ], { encoding: "utf8", windowsHide: true }).trim();
      return ticks ? `win32:${ticks}` : undefined;
    }
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    return started ? `${process.platform}:${started}` : undefined;
  } catch {
    return undefined;
  }
}

const defaultDependencies: ServiceDependencies = {
  isProcessRunning: processRunning,
  getProcessIdentity: processIdentity,
  signalProcess: (pid, signal) => process.kill(pid, signal),
  spawnDetached: ({ command, args, cwd, env, stdoutFd, stderrFd }) => spawn(command, args, {
    cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdoutFd, stderrFd]
  }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date()
};

export class ServiceController {
  readonly statePath: string;
  readonly logPath: string;
  private readonly dependencies: ServiceDependencies;

  constructor(
    readonly store: ConfigStore,
    dependencies: Partial<ServiceDependencies> = {}
  ) {
    this.statePath = path.join(store.dataDir, "service-state.json");
    this.logPath = path.join(store.dataDir, "service.log");
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  async status(): Promise<ServiceStatus> {
    const state = await this.readState();
    if (!state) return { status: "stopped", statePath: this.statePath, logPath: this.logPath };
    if (state.version === 2 && this.matchesProcess(state)) return { status: "running", statePath: this.statePath, ...state };
    await this.removeState(state.pid, state.version === 2 ? state.processIdentity : undefined);
    return { status: "stopped", statePath: this.statePath, logPath: this.logPath, stalePid: state.pid };
  }

  async assertStopped(): Promise<void> {
    const current = await this.status();
    if (current.status === "running") {
      throw new AppError("SERVICE_ALREADY_RUNNING", `Secure Host MCP is already running with PID ${current.pid}`, 409);
    }
  }

  async recordRunning(mode: ServiceState["mode"], pid = process.pid): Promise<ServiceState> {
    const identity = this.dependencies.getProcessIdentity(pid);
    if (!identity) {
      throw new AppError("SERVICE_IDENTITY_UNAVAILABLE", `Unable to determine the identity of process ${pid}`, 500);
    }
    const state: ServiceState = {
      version: 2,
      pid,
      processIdentity: identity,
      mode,
      startedAt: this.dependencies.now().toISOString(),
      ...(mode === "daemon" ? { logPath: this.logPath } : {})
    };
    await atomicWriteJson(this.statePath, state, true);
    return state;
  }

  async clear(pid = process.pid): Promise<void> {
    await this.removeState(pid);
  }

  async startDaemon(entry: string, cwd = process.cwd()): Promise<ServiceStatus> {
    await this.assertStopped();
    await mkdir(this.store.dataDir, { recursive: true });
    const stdoutFd = openSync(this.logPath, "a");
    const stderrFd = openSync(this.logPath, "a");
    let child: ChildProcess;
    try {
      child = this.dependencies.spawnDetached({
        command: process.execPath,
        args: [entry, "_serve"],
        cwd,
        env: { ...process.env, SECURE_HOST_MCP_HOME: this.store.dataDir },
        stdoutFd,
        stderrFd
      });
      child.unref();
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }

    if (!child.pid) throw new AppError("SERVICE_START_FAILED", `Failed to create the background process. See ${this.logPath}`, 500);
    const childIdentity = this.dependencies.getProcessIdentity(child.pid);
    if (!childIdentity) {
      await this.removeState(child.pid);
      throw new AppError("SERVICE_START_FAILED", `Unable to verify the background process identity. See ${this.logPath}`, 500);
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await this.readState();
      if (state?.version === 2 && state.pid === child.pid && this.matchesProcess(state)) {
        return { status: "running", statePath: this.statePath, ...state };
      }
      if (
        !this.dependencies.isProcessRunning(child.pid)
        || this.dependencies.getProcessIdentity(child.pid) !== childIdentity
      ) {
        await this.removeState(child.pid);
        throw new AppError("SERVICE_START_FAILED", `Background process exited during startup. See ${this.logPath}`, 500);
      }
      await this.dependencies.sleep(100);
    }
    this.signalIfMatching(child.pid, childIdentity, "SIGKILL");
    await this.removeState(child.pid);
    throw new AppError("SERVICE_START_TIMEOUT", `Background process did not report ready within 10 seconds. See ${this.logPath}`, 504);
  }

  async stop(force = false): Promise<ServiceStatus> {
    const current = await this.status();
    if (current.status === "stopped") return current;
    if (!this.signalIfMatching(current.pid, current.processIdentity, force ? "SIGKILL" : "SIGTERM")) {
      await this.removeState(current.pid, current.processIdentity);
      return { status: "stopped", statePath: this.statePath, logPath: this.logPath, stalePid: current.pid };
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!this.matchesProcess(current)) {
        await this.removeState(current.pid, current.processIdentity);
        return { status: "stopped", statePath: this.statePath, logPath: this.logPath };
      }
      await this.dependencies.sleep(100);
    }
    throw new AppError("SERVICE_STOP_TIMEOUT", `PID ${current.pid} did not stop within 10 seconds; retry with --force`, 504);
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      this.dependencies.signalProcess(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private matchesProcess(state: StoredServiceState): boolean {
    return state.version === 2
      && this.matchesIdentity(state.pid, state.processIdentity);
  }

  private matchesIdentity(pid: number, identity: string): boolean {
    return this.dependencies.isProcessRunning(pid)
      && this.dependencies.getProcessIdentity(pid) === identity;
  }

  private signalIfMatching(pid: number, identity: string, signal: NodeJS.Signals): boolean {
    if (!this.matchesIdentity(pid, identity)) return false;
    this.signal(pid, signal);
    return true;
  }

  private async readState(): Promise<StoredServiceState | undefined> {
    try {
      return z.union([ServiceStateSchema, LegacyServiceStateSchema]).parse(JSON.parse(await readFile(this.statePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new AppError("SERVICE_STATE_INVALID", `Invalid service state at ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  }

  private async removeState(expectedPid: number, expectedIdentity?: string): Promise<void> {
    const current = await this.readState();
    if (
      current?.pid === expectedPid
      && (expectedIdentity === undefined || (current.version === 2 && current.processIdentity === expectedIdentity))
    ) {
      await rm(this.statePath, { force: true });
    }
  }
}
