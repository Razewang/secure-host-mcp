import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { parseSystemdCloudflaredService, parseWindowsCloudflaredService, TunnelManager } from "../src/tunnels.js";

const TUNNEL_LIFECYCLE_TIMEOUT_MS = 15000;

const runningQuery = [
  "SERVICE_NAME: Cloudflared",
  "        TYPE               : 10  WIN32_OWN_PROCESS",
  "        STATE              : 4  RUNNING",
  "                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)"
].join("\n");

const stoppedQuery = [
  "SERVICE_NAME: Cloudflared",
  "        TYPE               : 10  WIN32_OWN_PROCESS",
  "        STATE              : 1  STOPPED"
].join("\n");

function scConfig(binaryPath: string): string {
  return [
    "[SC] QueryServiceConfig SUCCESS",
    "SERVICE_NAME: Cloudflared",
    "        TYPE               : 10  WIN32_OWN_PROCESS",
    `        BINARY_PATH_NAME   : ${binaryPath}`,
    "        DISPLAY_NAME       : Cloudflared agent"
  ].join("\n");
}

describe("external cloudflared service detection", () => {
  it("detects a running Windows token-file service without returning its command", () => {
    const status = parseWindowsCloudflaredService(
      runningQuery,
      scConfig("\"C:\\Program Files\\cloudflared\\cloudflared.exe\" tunnel run --token-file C:\\ProgramData\\cloudflared\\token")
    );

    expect(status).toEqual({ source: "windows-service", tokenManaged: true });
    expect(JSON.stringify(status)).not.toContain("ProgramData");
  });

  it("recognizes an inline token but never includes it in the parsed status", () => {
    const status = parseWindowsCloudflaredService(
      runningQuery,
      scConfig("cloudflared.exe tunnel run --token highly-sensitive-value")
    );

    expect(status).toEqual({ source: "windows-service", tokenManaged: true });
    expect(JSON.stringify(status)).not.toContain("highly-sensitive-value");
  });

  it("recognizes equals-form token arguments", () => {
    expect(parseWindowsCloudflaredService(
      runningQuery,
      scConfig("cloudflared.exe tunnel run --token=secret")
    )).toEqual({ source: "windows-service", tokenManaged: true });
    expect(parseWindowsCloudflaredService(
      runningQuery,
      scConfig("cloudflared.exe tunnel run --token-file=C:\\ProgramData\\cloudflared\\token")
    )).toEqual({ source: "windows-service", tokenManaged: true });
  });

  it("ignores stopped or non-tunnel Windows services", () => {
    expect(parseWindowsCloudflaredService(
      stoppedQuery,
      scConfig("cloudflared.exe tunnel run --token-file token")
    )).toBeUndefined();
    expect(parseWindowsCloudflaredService(
      runningQuery,
      scConfig("C:\\Windows\\System32\\svchost.exe -k netsvcs")
    )).toBeUndefined();
    expect(parseWindowsCloudflaredService("not-sc-output", "also-not-sc")).toBeUndefined();
  });

  it("detects active systemd services using token and config modes", () => {
    expect(parseSystemdCloudflaredService([
      "ActiveState=active",
      "ExecStart={ path=/usr/bin/cloudflared ; argv[]=/usr/bin/cloudflared tunnel run --token-file /etc/cloudflared/token ; }"
    ].join("\n"))).toEqual({ source: "systemd-service", tokenManaged: true });

    expect(parseSystemdCloudflaredService([
      "ActiveState=active",
      "ExecStart={ path=/usr/bin/cloudflared ; argv[]=/usr/bin/cloudflared tunnel --config /etc/cloudflared/config.yml run ; }"
    ].join("\n"))).toEqual({ source: "systemd-service", tokenManaged: false });
  });

  it("ignores inactive systemd services", () => {
    expect(parseSystemdCloudflaredService([
      "ActiveState=inactive",
      "ExecStart={ path=/usr/bin/cloudflared ; argv[]=/usr/bin/cloudflared tunnel run --token secret ; }"
    ].join("\n"))).toBeUndefined();
  });

  it("reports an injected external lifecycle and refuses a duplicate start", { timeout: TUNNEL_LIFECYCLE_TIMEOUT_MS }, async () => {
    const config = await new ConfigStore("tunnel-test-data").loadConfig();
    const probe = async () => ({ source: "windows-service" as const, tokenManaged: true });
    const manager = new TunnelManager(config, probe);

    expect((await manager.inspect()).cloudflared).toMatchObject({
      installed: true,
      managedRunning: false,
      lifecycle: {
        state: "running",
        control: "external",
        source: "windows-service",
        tokenManaged: true
      }
    });
    await expect(manager.start("cloudflared")).rejects.toMatchObject({
      code: "TUNNEL_EXTERNALLY_MANAGED",
      status: 409
    });
  });
});
