import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { AppConfig } from "./config.js";
import { AppError } from "./types.js";

type TunnelKind = "cloudflared" | "frpc";
const SECRET_KEY = /(token|secret|password|credential|private.?key|cert)/i;

export interface TunnelStatus {
  installed: boolean;
  executable?: string;
  version?: string;
  configPath?: string;
  config?: unknown;
  configError?: string;
  managedRunning: boolean;
  pid?: number;
}

export interface TunnelInspection {
  cloudflared: TunnelStatus;
  frpc: TunnelStatus;
}

export interface TunnelInstallResult {
  installed: true;
  kind: TunnelKind;
  version?: string;
  destination: string;
  sha256: string;
}

function findExecutable(name: string, localBin?: string): string | undefined {
  if (localBin && spawnSync(localBin, ["--version"], { windowsHide: true }).status === 0) return localBin;
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0]?.trim() : undefined;
}
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redact(item)]));
  return value;
}

export class TunnelManager {
  private readonly processes = new Map<TunnelKind, ChildProcess>();
  constructor(private readonly config: AppConfig) {}

  async inspect(): Promise<TunnelInspection> {
    return { cloudflared: await this.inspectOne("cloudflared"), frpc: await this.inspectOne("frpc") };
  }
  private async inspectOne(kind: TunnelKind): Promise<TunnelStatus> {
    const executable = this.executable(kind); const configPath = kind === "cloudflared" ? await this.cloudflaredConfig() : this.config.tunnels.frpcConfig;
    let parsed: unknown, error: string | undefined;
    if (configPath) try { const raw = await readFile(configPath, "utf8"); parsed = redact(YAML.parse(raw)); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    const version = executable ? spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true }).stdout.trim() : undefined;
    const running = this.processes.get(kind); return { installed: Boolean(executable), executable, version, configPath, config: parsed, configError: error, managedRunning: Boolean(running && running.exitCode === null), pid: running?.pid };
  }
  async start(kind: TunnelKind): Promise<Record<string, unknown>> {
    if (this.processes.get(kind)?.exitCode === null) throw new AppError("TUNNEL_RUNNING", `${kind} is already running`);
    const executable = this.executable(kind); if (!executable) throw new AppError("TUNNEL_NOT_INSTALLED", `${kind} is not installed`, 404);
    const configPath = kind === "cloudflared" ? await this.cloudflaredConfig() : this.config.tunnels.frpcConfig;
    if (!configPath) throw new AppError("TUNNEL_CONFIG_MISSING", `${kind} configuration path not found`);
    if (kind === "frpc") { const check = spawnSync(executable, ["verify", "-c", configPath], { encoding: "utf8", windowsHide: true }); if (check.status !== 0) throw new AppError("TUNNEL_CONFIG_INVALID", check.stderr || check.stdout); }
    const args = kind === "cloudflared" ? ["tunnel", "--config", configPath, "run"] : ["-c", configPath];
    const child = spawn(executable, args, { env: this.proxyEnv(), windowsHide: true, stdio: "ignore" }); this.processes.set(kind, child); return { kind, pid: child.pid, started: true };
  }
  stop(kind: TunnelKind): void { const child = this.processes.get(kind); if (!child || child.exitCode !== null) throw new AppError("TUNNEL_NOT_RUNNING", `${kind} is not managed by this process`, 404); child.kill("SIGTERM"); }
  installPlan(kind: TunnelKind): Record<string, unknown> { return kind === "cloudflared" ? { source: "https://github.com/cloudflare/cloudflared/releases/latest", commands: process.platform === "win32" ? ["winget install --id Cloudflare.cloudflared"] : ["Install the official cloudflared package for your distribution"] } : { source: "https://github.com/fatedier/frp/releases/latest", commands: ["Download the matching official frp archive, verify its checksum, and place frpc on PATH"] }; }
  async install(kind: TunnelKind, confirmed: boolean): Promise<TunnelInstallResult> {
    if (!confirmed) throw new AppError("CONFIRMATION_REQUIRED", "installation requires explicit confirmation");
    const repo = kind === "cloudflared" ? "cloudflare/cloudflared" : "fatedier/frp";
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "secure-host-mcp" } });
    if (!response.ok) throw new AppError("DOWNLOAD_FAILED", `GitHub release lookup failed: ${response.status}`, 502);
    const release = await response.json() as { tag_name?: string; assets?: Array<{ name: string; browser_download_url: string; digest?: string }> };
    const osName = process.platform === "win32" ? "windows" : "linux"; const archName = process.arch === "arm64" ? "arm64" : "amd64";
    const asset = release.assets?.find((item) => kind === "cloudflared" ? item.name === `cloudflared-${osName}-${archName}${process.platform === "win32" ? ".exe" : ""}` : item.name.includes(`${osName}_${archName}`) && item.name.endsWith(process.platform === "win32" ? ".zip" : ".tar.gz"));
    if (!asset) throw new AppError("ASSET_NOT_FOUND", `No ${kind} release for ${osName}/${archName}`, 404);
    if (!asset.digest?.startsWith("sha256:")) throw new AppError("CHECKSUM_MISSING", "Official release asset did not provide a SHA-256 digest; refusing automatic installation", 502);
    const download = await fetch(asset.browser_download_url); if (!download.ok) throw new AppError("DOWNLOAD_FAILED", `asset download failed: ${download.status}`, 502); const bytes = Buffer.from(await download.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex"); if (actual !== asset.digest.slice(7)) throw new AppError("CHECKSUM_MISMATCH", "downloaded asset checksum mismatch", 502);
    const binDir = path.join(this.config.dataDir, "bin"); await mkdir(binDir, { recursive: true }); const destination = path.join(binDir, `${kind}${process.platform === "win32" ? ".exe" : ""}`);
    if (kind === "cloudflared") await writeFile(destination, bytes, { mode: 0o755 });
    else {
      const temp = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-install-")); const archive = path.join(temp, asset.name); await writeFile(archive, bytes);
      const extract = path.join(temp, "extract"); await mkdir(extract);
      const unpack = process.platform === "win32" ? spawnSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${extract.replaceAll("'", "''")}'`], { windowsHide: true }) : spawnSync("tar", ["-xzf", archive, "-C", extract]);
      if (unpack.status !== 0) { await rm(temp, { recursive: true, force: true }); throw new AppError("EXTRACT_FAILED", "failed to extract frpc release archive", 500); }
      const source = path.join(extract, `frp_${release.tag_name?.replace(/^v/, "")}_${osName}_${archName}`, `${kind}${process.platform === "win32" ? ".exe" : ""}`); await copyFile(source, destination); if (process.platform !== "win32") await chmod(destination, 0o755); await rm(temp, { recursive: true, force: true });
    }
    return { installed: true, kind, version: release.tag_name, destination, sha256: actual };
  }
  private proxyEnv(): NodeJS.ProcessEnv { const env = { ...process.env }; if (this.config.tunnels.proxyUrl) { env.ALL_PROXY = this.config.tunnels.proxyUrl; env.HTTPS_PROXY = this.config.tunnels.proxyUrl; env.HTTP_PROXY = this.config.tunnels.proxyUrl; } return env; }
  private async cloudflaredConfig(): Promise<string | undefined> { if (this.config.tunnels.cloudflaredConfig) return this.config.tunnels.cloudflaredConfig; const candidates = process.platform === "win32" ? [path.join(os.homedir(), ".cloudflared", "config.yml"), path.join(os.homedir(), ".cloudflared", "config.yaml")] : [path.join(os.homedir(), ".cloudflared", "config.yml"), "/etc/cloudflared/config.yml", "/usr/local/etc/cloudflared/config.yml"]; for (const file of candidates) try { await access(file); return file; } catch { /* try next */ } return undefined; }
  private executable(kind: TunnelKind): string | undefined { return findExecutable(kind, path.join(this.config.dataDir, "bin", `${kind}${process.platform === "win32" ? ".exe" : ""}`)); }
}
