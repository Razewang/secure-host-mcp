import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth.js";
import { ConfigStore, type ConfiguredToken } from "../src/config.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("AuthService", () => {
  it("supports administrator bearer and OAuth PKCE with rotating refresh", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir); const admin = await store.ensureAdminToken(); const config = await store.loadConfig(); const auth = new AuthService(config, store); await auth.initialize();
    expect((await auth.authenticate(admin!)).scopes).toContain("admin.manage");
    const client = await auth.registerClient({ client_name: "test", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "client_secret_post" }); const verifier = "a".repeat(48); const challenge = createHash("sha256").update(verifier).digest("base64url");
    const code = await auth.issueCode({ clientId: String(client.client_id), redirectUri: "http://127.0.0.1/callback", scope: "command.run", challenge });
    const tokens = await auth.exchange(new URLSearchParams({ grant_type: "authorization_code", client_id: String(client.client_id), client_secret: String(client.client_secret), redirect_uri: "http://127.0.0.1/callback", code, code_verifier: verifier }));
    expect((await auth.authenticate(String(tokens.access_token))).scopes).toEqual(["command.run"]); expect(tokens.refresh_token).toBeTruthy();
    await expect(auth.exchange(new URLSearchParams({ grant_type: "authorization_code", client_id: String(client.client_id), client_secret: String(client.client_secret), redirect_uri: "http://127.0.0.1/callback", code, code_verifier: verifier }))).rejects.toThrow();
  });
  it("rejects unsafe dynamic-registration redirect URIs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir); await store.ensureAdminToken("admin"); const auth = new AuthService(await store.loadConfig(), store); await auth.initialize();
    await expect(auth.registerClient({ redirect_uris: ["http://evil.example/callback"] })).rejects.toThrow("valid redirect_uris");
  });

  it("loads administrator and additional connection tokens from tokens.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    await store.saveTokenConfig({
      version: 1,
      adminToken: "123456",
      connectionTokens: [{ id: "local-agent", token: "agentABC", label: "Local agent", scopes: ["system.read", "command.run"] }]
    });
    const config = await store.loadConfig(); const auth = new AuthService(config, store); await auth.initialize();
    expect(auth.requireAdmin("123456")).toBe(true);
    expect((await auth.authenticate("123456")).scopes).toContain("admin.manage");
    expect((await auth.authenticate("agentABC")).scopes).toEqual(["system.read", "command.run"]);
    expect(auth.listTokens()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "admin", role: "admin", revocable: false }),
      expect.objectContaining({ id: "local-agent", label: "Local agent", role: "agent", revocable: true })
    ]));
  });

  it("creates and revokes connection tokens in the single token registry", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    await store.ensureAdminToken("admin");
    const auth = new AuthService(await store.loadConfig(), store); await auth.initialize();
    const created = await auth.createToken("Dashboard", ["system.read"]);
    expect((await auth.authenticate(created.token)).id).toBe(created.id);
    expect((await store.loadTokenConfig())?.connectionTokens).toEqual([expect.objectContaining({ id: created.id, token: created.token })]);
    await auth.revokeToken(created.id);
    await expect(auth.authenticate(created.token)).rejects.toThrow("invalid or expired token");
  });

  it("serializes overlapping connection-token creations", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    await store.ensureAdminToken("admin");
    const auth = new AuthService(await store.loadConfig(), store); await auth.initialize();
    const originalSave = store.saveTokenConfig.bind(store);
    let releaseFirstSave!: () => void;
    let signalFirstSave!: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => { signalFirstSave = resolve; });
    const firstSaveBlocked = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    let saveCount = 0;
    store.saveTokenConfig = async (config) => {
      saveCount += 1;
      if (saveCount === 1) {
        signalFirstSave();
        await firstSaveBlocked;
      }
      await originalSave(config);
    };

    const firstPending = auth.createToken("First", ["system.read"]);
    await firstSaveStarted;
    const secondPending = auth.createToken("Second", ["command.run"]);
    releaseFirstSave();
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect((await store.loadTokenConfig())?.connectionTokens.map((record) => record.id)).toEqual([first.id, second.id]);
    expect((await auth.authenticate(first.token)).id).toBe(first.id);
    expect((await auth.authenticate(second.token)).id).toBe(second.id);
  });

  it("serializes token creation with revocation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    await store.saveTokenConfig({
      version: 1,
      adminToken: "admin",
      connectionTokens: [{ id: "old", token: "old-token", label: "Old", scopes: ["system.read"] }]
    });
    const auth = new AuthService(await store.loadConfig(), store); await auth.initialize();
    const originalSave = store.saveTokenConfig.bind(store);
    let releaseFirstSave!: () => void;
    let signalFirstSave!: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => { signalFirstSave = resolve; });
    const firstSaveBlocked = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    let saveCount = 0;
    store.saveTokenConfig = async (config) => {
      saveCount += 1;
      if (saveCount === 1) {
        signalFirstSave();
        await firstSaveBlocked;
      }
      await originalSave(config);
    };

    const createPending = auth.createToken("New", ["command.run"]);
    await firstSaveStarted;
    const revokePending = auth.revokeToken("old");
    releaseFirstSave();
    const [created] = await Promise.all([createPending, revokePending]);

    expect((await store.loadTokenConfig())?.connectionTokens.map((record) => record.id)).toEqual([created.id]);
    expect((await auth.authenticate(created.token)).id).toBe(created.id);
    await expect(auth.authenticate("old-token")).rejects.toThrow("invalid or expired token");
  });

  it("continues token mutations after a failed save", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    await store.ensureAdminToken("admin");
    const auth = new AuthService(await store.loadConfig(), store); await auth.initialize();
    const originalSave = store.saveTokenConfig.bind(store);
    let saveCount = 0;
    store.saveTokenConfig = async (config) => {
      saveCount += 1;
      if (saveCount === 1) throw new Error("simulated write failure");
      await originalSave(config);
    };

    await expect(auth.createToken("Failed", ["system.read"])).rejects.toThrow("simulated write failure");
    const created = await auth.createToken("Recovered", ["command.run"]);

    expect((await store.loadTokenConfig())?.connectionTokens.map((record) => record.id)).toEqual([created.id]);
    expect((await auth.authenticate(created.token)).id).toBe(created.id);
  });

  it("keeps derived connection-token identities stable when the file is reordered", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    const first: ConfiguredToken = { token: "first-token", label: "First", scopes: ["system.read"] };
    const second: ConfiguredToken = { token: "second-token", label: "Second", scopes: ["command.run"] };
    await store.saveTokenConfig({ version: 1, adminToken: "admin", connectionTokens: [first, second] });
    const before = new AuthService(await store.loadConfig(), store); await before.initialize();
    const firstId = (await before.authenticate(first.token)).id;
    const secondId = (await before.authenticate(second.token)).id;
    await store.saveTokenConfig({ version: 1, adminToken: "admin", connectionTokens: [second, first] });
    const after = new AuthService(await store.loadConfig(), store); await after.initialize();
    expect((await after.authenticate(first.token)).id).toBe(firstId);
    expect((await after.authenticate(second.token)).id).toBe(secondId);
  });

  it("fails closed when setup has not created the token registry", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    const auth = new AuthService(await store.loadConfig(), store);
    await expect(auth.initialize()).rejects.toThrow("Run setup before starting");
  });
});
