import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth.js";
import { ConfigStore } from "../src/config.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("AuthService", () => {
  it("supports owner bearer and OAuth PKCE with rotating refresh", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir); const owner = await store.ensureOwnerToken(); const config = await store.loadConfig(); const auth = new AuthService(config, store); await auth.initialize();
    expect((await auth.authenticate(owner!)).scopes).toContain("admin.manage");
    const client = await auth.registerClient({ client_name: "test", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "client_secret_post" }); const verifier = "a".repeat(48); const challenge = createHash("sha256").update(verifier).digest("base64url");
    const code = await auth.issueCode({ clientId: String(client.client_id), redirectUri: "http://127.0.0.1/callback", scope: "command.run", challenge });
    const tokens = await auth.exchange(new URLSearchParams({ grant_type: "authorization_code", client_id: String(client.client_id), client_secret: String(client.client_secret), redirect_uri: "http://127.0.0.1/callback", code, code_verifier: verifier }));
    expect((await auth.authenticate(String(tokens.access_token))).scopes).toEqual(["command.run"]); expect(tokens.refresh_token).toBeTruthy();
    await expect(auth.exchange(new URLSearchParams({ grant_type: "authorization_code", client_id: String(client.client_id), client_secret: String(client.client_secret), redirect_uri: "http://127.0.0.1/callback", code, code_verifier: verifier }))).rejects.toThrow();
  });
  it("rejects unsafe dynamic-registration redirect URIs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir); const auth = new AuthService(await store.loadConfig(), store); await auth.initialize();
    await expect(auth.registerClient({ redirect_uris: ["http://evil.example/callback"] })).rejects.toThrow("valid redirect_uris");
  });
});
