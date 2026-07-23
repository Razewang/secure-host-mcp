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

const dirs: string[] = []; const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
function listen(app: Express): Promise<number> { return new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => { servers.push(server); const address = server.address(); resolve(typeof address === "object" && address ? address.port : 0); }); }); }

describe("HTTP integration", () => {
  it("authenticates an MCP client and keeps admin routes off the public app", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir); const owner = await store.ensureOwnerToken(); const created = await createApplication(store); const port = await listen(created.mcpApp);
    expect((await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    const client = new Client({ name: "integration-test", version: "1" }); const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${owner}` } } });
    await client.connect(transport); const tools = await client.listTools(); expect(tools.tools.map((tool) => tool.name)).toContain("execute_command"); await client.close(); await created.close();
  });

  it("keeps the remotely bound administration API behind the owner token", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir); const owner = await store.ensureOwnerToken(); const created = await createApplication(store); const port = await listen(created.adminApp);
    expect(created.config.admin.host).toBe("0.0.0.0");
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/status`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { authorization: `Bearer ${owner}` } })).status).toBe(200);
    await created.close();
  });
});
