import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.js";
import { setupSummary } from "../src/launch.js";
import { detectPublicIp, prepareInstallation } from "../src/setup.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("interactive launch preparation", () => {
  it("persists defaults and creates the editable administrator token only once", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-launch-")); dirs.push(dir); const store = new ConfigStore(dir);
    const first = await prepareInstallation(store, { adminToken: "my-token", hasPublicIp: true, publicAddress: "203.0.113.8" }); const second = await prepareInstallation(store);
    expect(first.adminToken).toBe("my-token"); expect(second.adminToken).toBeUndefined();
    expect(JSON.parse(await readFile(store.configPath, "utf8"))).toMatchObject({ version: 1, dataDir: dir, mcp: { host: "0.0.0.0" }, admin: { host: "0.0.0.0" } });
    expect(JSON.parse(await readFile(store.tokensPath, "utf8"))).toEqual({ version: 1, adminToken: "my-token", connectionTokens: [] });
    expect(setupSummary(first.config).join("\n")).toContain("non-loopback listeners accept remote connections");
    expect(setupSummary(first.config).join("\n")).toContain("HTTP is plaintext");
    expect(setupSummary(first.config).join("\n")).toContain("ChatGPT requires a public HTTPS MCP URL");
    expect(setupSummary(first.config).join("\n")).toContain("Public MCP URL: http://203.0.113.8:8767/mcp");
    expect(setupSummary(first.config).join("\n")).toContain("Web console URL: http://203.0.113.8:8768/");
  });

  it("formats IPv6 bind URLs and warns for every non-loopback listener", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-launch-")); dirs.push(dir); const store = new ConfigStore(dir);
    const config = await store.loadConfig(); config.mcp.host = "::"; config.admin.host = "2001:db8::10";
    const summary = setupSummary(config).join("\n");
    expect(summary).toContain("MCP bind: http://[::]:8767/mcp");
    expect(summary).toContain("Administration bind: http://[2001:db8::10]:8768/");
    expect(summary).toContain("non-loopback listeners accept remote connections");
  });

  it.each(["192.168.1.10", "203.0.113.10"])("warns for the concrete IPv4 listener %s", async (host) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-launch-")); dirs.push(dir); const store = new ConfigStore(dir);
    const config = await store.loadConfig(); config.mcp.host = "127.0.0.1"; config.admin.host = host;
    expect(setupSummary(config).join("\n")).toContain("non-loopback listeners accept remote connections");
  });

  it("does not warn when both listeners are loopback addresses", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-launch-")); dirs.push(dir); const store = new ConfigStore(dir);
    const config = await store.loadConfig(); config.mcp.host = "::1"; config.admin.host = "127.0.0.2"; config.publicBaseUrl = "https://mcp.example.test";
    const summary = setupSummary(config).join("\n");
    expect(summary).toContain("MCP bind: http://[::1]:8767/mcp");
    expect(summary).not.toContain("NETWORK:");
    expect(summary).not.toContain("WARNING:");
  });

  it("detects and validates the public IP returned by Cloudflare", async () => {
    const fetcher = vi.fn(async () => new Response("fl=1\nip=2001:db8::20\nts=1\n")) as typeof fetch;
    await expect(detectPublicIp(fetcher)).resolves.toBe("2001:db8::20");
  });

  it("explains when direct public URLs are unavailable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-launch-")); dirs.push(dir); const store = new ConfigStore(dir);
    const prepared = await prepareInstallation(store, { hasPublicIp: false });
    expect(setupSummary(prepared.config).join("\n")).toContain("Public MCP URL: unavailable");
    expect(setupSummary(prepared.config).join("\n")).toContain("Web console URL: unavailable");
  });
});
