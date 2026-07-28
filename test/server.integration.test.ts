import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

// These tests boot real HTTP servers and spawn tunnel-inspection child
// processes; slow Windows CI runners regularly blow the default 5s budget.
const INTEGRATION_TIMEOUT_MS = 20000;

describe("HTTP integration", () => {
  it("authenticates an MCP client and keeps admin routes off the public app", { timeout: INTEGRATION_TIMEOUT_MS }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir); const admin = "integration-admin";
    await store.saveTokenConfig({ version: 1, adminToken: admin, connectionTokens: [
      { id: "coding-reader", token: "reader-token", label: "Coding reader", scopes: ["workspace.read"] },
      { id: "runtime-owner", token: "runtime-token", label: "Runtime owner", scopes: ["system.read", "command.run", "workspace.read"] }
    ] });
    const created = await createApplication(store); const { port } = await listen(created.mcpApp);
    expect((await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    const client = new Client({ name: "integration-test", version: "1" }); const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${admin}` } } });
    await writeFile(path.join(dir, "workspace", "hello.ts"), "export const hello = true;\n", "utf8");
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["execute_command", "create_terminal", "runtime_snapshot", "read_file", "apply_patch", "git_status"]));
    const runtimeTool = tools.tools.find((tool) => tool.name === "runtime_snapshot");
    expect(runtimeTool?._meta).toMatchObject({ ui: { resourceUri: "ui://secure-host/runtime-status-v1.html" } });
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain("ui://secure-host/runtime-status-v1.html");
    const runtimeResource = await client.readResource({ uri: "ui://secure-host/runtime-status-v1.html" });
    expect(runtimeResource.contents[0]?.mimeType).toContain("text/html");
    expect(String(runtimeResource.contents[0] && "text" in runtimeResource.contents[0] ? runtimeResource.contents[0].text : "")).toContain("Secure Host");
    const file = await client.callTool({ name: "read_file", arguments: { path: "hello.ts" } });
    const rawContent: unknown = file.content;
    expect(Array.isArray(rawContent)).toBe(true);
    const firstContent: unknown = Array.isArray(rawContent) ? rawContent[0] : undefined;
    expect(isRecord(firstContent) ? firstContent.type : undefined).toBe("text");
    expect(isRecord(firstContent) ? String(firstContent.text) : "").toContain("export const hello");
    expect(isRecord(file.structuredContent) ? file.structuredContent.path : undefined).toBe("hello.ts");
    const originalSha = isRecord(file.structuredContent) ? String(file.structuredContent.sha256) : "";
    const patched = await client.callTool({ name: "apply_patch", arguments: { changes: [{ type: "replace", path: "hello.ts", oldText: "true", newText: "false", expectedSha256: originalSha }] } });
    expect(patched.isError).not.toBe(true);
    expect(await readFile(path.join(dir, "workspace", "hello.ts"), "utf8")).toContain("hello = false");
    const terminal = await client.callTool({ name: "create_terminal", arguments: {} });
    const terminalId = isRecord(terminal.structuredContent) ? String(terminal.structuredContent.terminalId) : "";
    expect(terminalId).toMatch(/^[0-9a-f-]{36}$/);
    await client.close();

    const resumedClient = new Client({ name: "resume-test", version: "1" });
    const resumedTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${admin}` } } });
    await resumedClient.connect(resumedTransport);
    const snapshot = await resumedClient.callTool({ name: "runtime_snapshot", arguments: {} });
    expect(isRecord(snapshot.structuredContent) ? snapshot.structuredContent.generatedAt : undefined).toBeTypeOf("string");
    const terminalRecords = isRecord(snapshot.structuredContent) && Array.isArray(snapshot.structuredContent.terminals) ? snapshot.structuredContent.terminals : [];
    expect(terminalRecords.some((record) => isRecord(record) && record.id === terminalId && record.ownerId === "admin")).toBe(true);
    await resumedClient.callTool({ name: "close_terminal", arguments: { terminalId } });
    await resumedClient.close();

    const ownerClient = new Client({ name: "owner-test", version: "1" });
    const ownerTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: "Bearer runtime-token" } } });
    await ownerClient.connect(ownerTransport);
    const ownerTerminal = await ownerClient.callTool({ name: "create_terminal", arguments: {} });
    const ownerTerminalId = isRecord(ownerTerminal.structuredContent) ? String(ownerTerminal.structuredContent.terminalId) : "";
    const ownerSnapshot = await ownerClient.callTool({ name: "runtime_snapshot", arguments: {} });
    const ownerRecords = isRecord(ownerSnapshot.structuredContent) && Array.isArray(ownerSnapshot.structuredContent.terminals) ? ownerSnapshot.structuredContent.terminals : [];
    expect(ownerRecords.some((record) => isRecord(record) && record.id === ownerTerminalId && !("ownerId" in record))).toBe(true);
    expect(isRecord(ownerSnapshot.structuredContent) ? ownerSnapshot.structuredContent.workspace : undefined).toBeTypeOf("object");
    await ownerClient.callTool({ name: "close_terminal", arguments: { terminalId: ownerTerminalId } });
    await ownerClient.close();

    const readClient = new Client({ name: "read-only-test", version: "1" });
    const readTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: "Bearer reader-token" } } });
    await readClient.connect(readTransport);
    await expect(readClient.callTool({ name: "read_file", arguments: { path: "hello.ts" } })).resolves.toBeDefined();
    const deniedSnapshot = await readClient.callTool({ name: "runtime_snapshot", arguments: {} });
    expect(deniedSnapshot.isError).toBe(true);
    expect(JSON.stringify(deniedSnapshot.content)).toContain("scope required: system.read");
    const denied = await readClient.callTool({ name: "apply_patch", arguments: { changes: [{ type: "create", path: "denied.ts", content: "no" }] } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("scope required: workspace.write");
    await expect(readFile(path.join(dir, "workspace", "denied.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await readClient.close(); await created.close();
  });

  it("keeps the remotely bound administration API behind the administrator token", { timeout: INTEGRATION_TIMEOUT_MS }, async () => {
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
    const status = await statusResponse.json() as { system: Record<string, unknown>; runtime: { jobs: unknown[]; terminals: unknown[] }; tunnels: { cloudflared: { managedRunning: unknown; lifecycle: unknown } }; config: { coding: { enabled: boolean } }; paths: Record<string, string> };
    expect(statusResponse.status).toBe(200);
    expect(typeof status.system.hostname).toBe("string");
    expect(typeof status.system.cpus).toBe("number");
    expect(typeof status.system.totalMemory).toBe("number");
    expect(typeof status.system.node).toBe("string");
    expect(status.config.coding.enabled).toBe(true);
    expect(status.runtime.jobs).toEqual([]);
    expect(status.runtime.terminals).toEqual([]);
    expect(typeof status.tunnels.cloudflared.managedRunning).toBe("boolean");
    expect(status.tunnels.cloudflared.lifecycle).toBeTypeOf("object");
    const lifecycle = status.tunnels.cloudflared.lifecycle as Record<string, unknown>;
    expect(["stopped", "running"]).toContain(lifecycle.state);
    if (lifecycle.state === "running") expect(["managed", "external"]).toContain(lifecycle.control);
    expect(status.paths.dataDir).toBe(dir);
    expect(status.paths.configFile).toBe(path.join(dir, "config.json"));
    expect(status.paths.auditDirectory).toBe(path.join(dir, "audit"));
    expect((await fetch(`http://127.0.0.1:${port}/api/logs`)).status).toBe(401);
    const emptyLogs = await (await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { authorization: `Bearer ${admin}` } })).json() as { directory: string; files: unknown[] };
    expect(emptyLogs.directory).toBe(path.join(dir, "audit"));
    expect(emptyLogs.files).toEqual([]);
    await mkdir(path.join(dir, "audit"), { recursive: true });
    await writeFile(path.join(dir, "audit", "2026-07-26.jsonl"), '{"timestamp":"2026-07-26T00:00:00.000Z","action":"execute_command","success":true}\n', "utf8");
    const logsResponse = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { authorization: `Bearer ${admin}` } });
    const logs = await logsResponse.json() as { directory: string; files: Array<{ name: string; size: number; modifiedAt: string }> };
    expect(logsResponse.status).toBe(200);
    expect(logs.files.map((file) => file.name)).toEqual(["2026-07-26.jsonl"]);
    expect(logs.files[0]?.size).toBeGreaterThan(0);
    const logContentResponse = await fetch(`http://127.0.0.1:${port}/api/logs/2026-07-26.jsonl`, { headers: { authorization: `Bearer ${admin}` } });
    const logContent = await logContentResponse.json() as { name: string; truncated: boolean; content: string };
    expect(logContentResponse.status).toBe(200);
    expect(logContent.name).toBe("2026-07-26.jsonl");
    expect(logContent.truncated).toBe(false);
    expect(logContent.content).toContain("execute_command");
    expect((await fetch(`http://127.0.0.1:${port}/api/logs/2026-07-26.jsonl`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/logs/secrets.json`, { headers: { authorization: `Bearer ${admin}` } })).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/api/logs/..%2Fsecrets.jsonl`, { headers: { authorization: `Bearer ${admin}` } })).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/api/logs/2000-01-01.jsonl`, { headers: { authorization: `Bearer ${admin}` } })).status).toBe(404);
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
