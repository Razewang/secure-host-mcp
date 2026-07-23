import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { Express } from "express";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { createApplication } from "../src/server.js";
import { ALL_SCOPES } from "../src/types.js";

const dirs: string[] = []; const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
function listen(app: Express, host = "127.0.0.1"): Promise<{ address: string; port: number }> { return new Promise((resolve) => { const server = app.listen(0, host, () => { servers.push(server); const address = server.address(); resolve(typeof address === "object" && address ? { address: address.address, port: address.port } : { address: "", port: 0 }); }); }); }

describe("HTTP integration", () => {
  it("authenticates an MCP client and keeps admin routes off the public app", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir); const admin = await store.ensureAdminToken("integration-admin"); const created = await createApplication(store); const { port } = await listen(created.mcpApp);
    expect((await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    const client = new Client({ name: "integration-test", version: "1" }); const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${admin}` } } });
    await client.connect(transport); const tools = await client.listTools(); expect(tools.tools.map((tool) => tool.name)).toContain("execute_command"); await client.close(); await created.close();
  });

  it("keeps the remotely bound administration API behind the administrator token", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir); const admin = await store.ensureAdminToken("admin-integration-token"); const created = await createApplication(store); const bound = await listen(created.adminApp, created.config.admin.host); const { port } = bound;
    expect(created.config.admin.host).toBe("0.0.0.0");
    expect(bound.address).toBe("0.0.0.0");
    const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(pageResponse.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page).toContain('class="auth-gate"');
    expect(page).not.toContain("__SECURE_HOST_MCP_CSRF_TOKEN__");
    expect(page).not.toContain("__SECURE_HOST_MCP_SCOPES__");
    expect(page).not.toContain("preview-token");
    expect(page).toContain('src="/app.js"');
    expect(page).toContain('href="/styles.css"');
    const scopeLiteral = page.match(/"scopes":(\[[^\]]+\])/)?.[1];
    expect(scopeLiteral).toBeTruthy();
    expect(JSON.parse(scopeLiteral ?? "[]")).toEqual(ALL_SCOPES);
    const scriptResponse = await fetch(`http://127.0.0.1:${port}/app.js`);
    const styleResponse = await fetch(`http://127.0.0.1:${port}/styles.css`);
    expect(scriptResponse.status).toBe(200);
    expect(styleResponse.status).toBe(200);
    expect(await scriptResponse.text()).toContain('document.getElementById("admin-bootstrap")');
    expect(await styleResponse.text()).toContain(".auth-gate");
    const csrfLiteral = page.match(/"csrfToken":("[A-Za-z0-9_-]+")/)?.[1];
    expect(csrfLiteral).toBeTruthy();
    const csrf = JSON.parse(csrfLiteral ?? '""') as string;
    expect((await fetch(`http://127.0.0.1:${port}/api/status`)).status).toBe(401);
    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { authorization: `Bearer ${admin}` } });
    const status = await statusResponse.json() as { system: Record<string, unknown>; tunnels: { cloudflared: Record<string, unknown> } };
    expect(statusResponse.status).toBe(200);
    expect(typeof status.system.hostname).toBe("string");
    expect(typeof status.system.cpus).toBe("number");
    expect(typeof status.system.totalMemory).toBe("number");
    expect(typeof status.system.node).toBe("string");
    expect(status.tunnels.cloudflared).toHaveProperty("managedRunning");
    const createResponse = await fetch(`http://127.0.0.1:${port}/api/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ label: "Dashboard token", scopes: ["system.read"] })
    });
    const token = await createResponse.json() as { id: string; token: string; scopes: string[] };
    expect(createResponse.status).toBe(201);
    expect(token.id).toBeTypeOf("string");
    expect(token.token).toBeTypeOf("string");
    expect(token.scopes).toEqual(["system.read"]);
    expect((await fetch(`http://127.0.0.1:${port}/api/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE", headers: { authorization: `Bearer ${admin}`, "x-csrf-token": csrf } })).status).toBe(204);
    expect((await fetch(`http://127.0.0.1:${port}/api/tunnels/frpc/start`, { method: "POST", headers: { authorization: `Bearer ${admin}` } })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/tunnels/unknown/start`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "x-csrf-token": csrf } })).status).toBe(400);
    await created.close();
  });
});
