import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";

const dirs: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("ConfigStore", () => {
  it("defaults new installations to public listeners", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    expect(await store.loadConfig()).toMatchObject({ mcp: { host: "0.0.0.0", port: 8767 }, admin: { host: "0.0.0.0", port: 8768 } });
  });

  it("preserves explicit loopback listeners", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    const config = await store.loadConfig(); config.mcp.host = "127.0.0.1"; config.admin.host = "127.0.0.1"; await store.saveConfig(config);
    expect(await store.loadConfig()).toMatchObject({ mcp: { host: "127.0.0.1" }, admin: { host: "127.0.0.1" } });
  });

  it("creates an editable restricted token configuration for new installations", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    expect(await store.ensureAdminToken("admin123")).toBe("admin123");
    expect(await store.ensureAdminToken("replacement")).toBeUndefined();
    expect(await store.loadTokenConfig()).toEqual({ version: 1, adminToken: "admin123", connectionTokens: [] });
    if (process.platform !== "win32") expect((await stat(store.tokensPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects duplicate token values and identifiers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    await expect(store.saveTokenConfig({ version: 1, adminToken: "same", connectionTokens: [{ token: "same", label: "duplicate", scopes: [] }] })).rejects.toThrow("token value must be unique");
    await expect(store.saveTokenConfig({ version: 1, adminToken: "admin", connectionTokens: [
      { id: "duplicate", token: "first", label: "first", scopes: [] },
      { id: "duplicate", token: "second", label: "second", scopes: [] }
    ] })).rejects.toThrow("token id must be unique");
    await expect(store.saveTokenConfig({ version: 1, adminToken: "admin", connectionTokens: [
      { id: "admin", token: "connection", label: "reserved id", scopes: [] }
    ] })).rejects.toThrow("token id admin is reserved");
  });
});
