import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, tokenMatches } from "../src/config.js";

const dirs: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("ConfigStore", () => {
  it("defaults new installations to public listeners", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    expect(await store.loadConfig()).toMatchObject({ mcp: { host: "0.0.0.0", port: 8767 }, admin: { host: "0.0.0.0", port: 8768, allowLanHttp: true } });
  });

  it("preserves explicit loopback listeners", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    const config = await store.loadConfig(); config.mcp.host = "127.0.0.1"; config.admin.host = "127.0.0.1"; config.admin.allowLanHttp = false; await store.saveConfig(config);
    expect(await store.loadConfig()).toMatchObject({ mcp: { host: "127.0.0.1" }, admin: { host: "127.0.0.1", allowLanHttp: false } });
  });

  it("creates a one-time owner token and stores only its hash", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    const token = await store.ensureOwnerToken(); expect(token).toBeTruthy(); expect(await store.ensureOwnerToken()).toBeUndefined();
    const secrets = await store.loadSecrets(); expect(secrets.tokens).toHaveLength(1); expect(secrets.tokens[0] && tokenMatches(token!, secrets.tokens[0])).toBe(true);
    expect(await readFile(store.secretsPath, "utf8")).not.toContain(token!);
    if (process.platform !== "win32") expect((await stat(store.secretsPath)).mode & 0o777).toBe(0o600);
  });
});
