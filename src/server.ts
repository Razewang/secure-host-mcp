import { randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import { AuditLog } from "./audit.js";
import { AuthService } from "./auth.js";
import { ConfigStore, type AppConfig } from "./config.js";
import { CommandExecutor } from "./executor.js";
import { McpHost } from "./mcp.js";
import { ALL_SCOPES, AppError, type Scope } from "./types.js";
import { TunnelManager } from "./tunnels.js";
import { PrivilegeClient } from "./privilege.js";

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) { return (req: Request, res: Response, next: (error?: unknown) => void) => { void handler(req, res).catch(next); }; }
function bearer(req: Request): string { const value = req.headers.authorization; return value?.startsWith("Bearer ") ? value.slice(7) : ""; }

export async function createApplication(store = new ConfigStore()): Promise<{ mcpApp: express.Express; adminApp: express.Express; config: AppConfig; close: () => Promise<void> }> {
  const config = await store.loadConfig(); const auth = new AuthService(config, store); await auth.initialize(); const audit = new AuditLog(config); await audit.prune();
  const executor = new CommandExecutor(config); const tunnels = new TunnelManager(config); const mcp = new McpHost(config, executor, tunnels, audit, new PrivilegeClient(config, store));
  const mcpApp = express(); const adminApp = express();
  for (const app of [mcpApp, adminApp]) { app.disable("x-powered-by"); app.use(express.json({ limit: "1mb" })); app.use(express.urlencoded({ extended: false })); }
  const attempts = new Map<string, { count: number; resetAt: number }>();
  adminApp.use((req, res, next) => { const origin = req.headers.origin; const host = req.headers.host; if (origin && host && new URL(origin).host !== host) { res.status(403).json({ error: "ORIGIN_REJECTED" }); return; } const key = req.ip ?? "unknown", now = Date.now(), current = attempts.get(key); const item = !current || current.resetAt < now ? { count: 0, resetAt: now + 60000 } : current; item.count += 1; attempts.set(key, item); if (item.count > 120) { res.status(429).json({ error: "RATE_LIMITED" }); return; } res.set({ "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; frame-ancestors 'none'", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" }); next(); });
  mcpApp.get("/.well-known/oauth-protected-resource", (_req, res) => res.json(auth.resourceMetadata()));
  mcpApp.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json(auth.resourceMetadata()));
  mcpApp.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(auth.metadata()));
  mcpApp.get("/.well-known/openid-configuration", (_req, res) => res.json(auth.metadata()));
  mcpApp.post("/oauth/register", asyncRoute(async (req, res) => { res.status(201).json(await auth.registerClient(req.body)); }));
  mcpApp.get("/oauth/authorize", (req, res) => {
    const p = new URLSearchParams(req.query as Record<string, string>); const client = auth.getClient(p.get("client_id") ?? "");
    if (!client || p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256") { res.status(400).send("Invalid OAuth authorization request"); return; }
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Authorize Secure Host MCP</title><h1>Authorize ${escapeHtml(client.client_name)}</h1><p>Redirect: ${escapeHtml(p.get("redirect_uri") ?? "")}</p><p>Scopes: ${escapeHtml(p.get("scope") ?? "")}</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${escapeHtml(Buffer.from(p.toString()).toString("base64url"))}"><label>Owner token <input type="password" name="owner_token" required></label><button>Authorize</button></form>`);
  });
  mcpApp.post("/oauth/authorize", asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (!auth.requireOwner(typeof body.owner_token === "string" ? body.owner_token : "")) throw new AppError("INVALID_OWNER", "Owner token is invalid", 401);
    const p = new URLSearchParams(Buffer.from(typeof body.request === "string" ? body.request : "", "base64url").toString()); if (p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256") throw new AppError("INVALID_REQUEST", "authorization code with PKCE S256 is required"); const code = await auth.issueCode({ clientId: p.get("client_id") ?? "", redirectUri: p.get("redirect_uri") ?? "", scope: p.get("scope") ?? "", challenge: p.get("code_challenge") ?? "" });
    const redirect = new URL(p.get("redirect_uri")!); redirect.searchParams.set("code", code); if (p.get("state")) redirect.searchParams.set("state", p.get("state")!); res.redirect(303, redirect.toString());
  }));
  mcpApp.post("/oauth/token", asyncRoute(async (req, res) => { res.json(await auth.exchange(new URLSearchParams(req.body as Record<string, string>))); }));
  mcpApp.post("/oauth/revoke", asyncRoute(async (req, res) => { const body = req.body as Record<string, unknown>; await auth.revoke(typeof body.token === "string" ? body.token : ""); res.status(200).end(); }));
  mcpApp.post("/mcp", auth.middleware, asyncRoute(mcp.handlePost)); mcpApp.get("/mcp", auth.middleware, asyncRoute(mcp.handleGet)); mcpApp.delete("/mcp", auth.middleware, asyncRoute(mcp.handleDelete));
  if (config.legacySse) { mcpApp.get("/sse", auth.middleware, asyncRoute(mcp.handleLegacyGet)); mcpApp.post("/messages", auth.middleware, asyncRoute(mcp.handleLegacyPost)); }

  const csrf = randomBytes(24).toString("base64url");
  adminApp.get("/", (_req, res) => res.type("html").send(adminHtml(csrf)));
  adminApp.get("/api/status", asyncRoute(async (req, res) => { if (!auth.requireOwner(bearer(req))) throw new AppError("UNAUTHORIZED", "Owner Bearer token required", 401); res.json({ system: executor.systemInfo(), tunnels: await tunnels.inspect(), config: { mcp: config.mcp, admin: config.admin, publicBaseUrl: config.publicBaseUrl } }); }));
  adminApp.get("/api/tokens", (req, res) => { if (!auth.requireOwner(bearer(req))) throw new AppError("UNAUTHORIZED", "Owner Bearer token required", 401); res.json(auth.listTokens()); });
  adminApp.post("/api/tokens", asyncRoute(async (req, res) => { requireAdminRequest(req, auth, csrf); const body = req.body as Record<string, unknown>; const requested = Array.isArray(body.scopes) ? body.scopes.filter((value): value is Scope => typeof value === "string" && (ALL_SCOPES as readonly string[]).includes(value)) : [...ALL_SCOPES]; res.status(201).json(await auth.createToken(typeof body.label === "string" ? body.label : "Agent token", requested)); }));
  adminApp.delete("/api/tokens/:id", asyncRoute(async (req, res) => { requireAdminRequest(req, auth, csrf); await auth.revokeToken(String(req.params.id)); res.status(204).end(); }));
  adminApp.post("/api/tunnels/:kind/:action", asyncRoute(async (req, res) => { if (req.headers["x-csrf-token"] !== csrf || !auth.requireOwner(bearer(req))) throw new AppError("UNAUTHORIZED", "Owner token and CSRF token required", 401); const kind = req.params.kind === "frpc" ? "frpc" : "cloudflared"; if (req.params.action === "start") res.json(await tunnels.start(kind)); else { tunnels.stop(kind); res.json({ stopped: true }); } }));
  const errorHandler = (error: unknown, _req: Request, res: Response, next: (error?: unknown) => void) => { void next; const appError = error instanceof AppError ? error : new AppError("INTERNAL", error instanceof Error ? error.message : "Internal error", 500); res.status(appError.status).json({ error: appError.code, message: appError.message }); };
  mcpApp.use(errorHandler); adminApp.use(errorHandler);
  return { mcpApp, adminApp, config, close: () => mcp.close() };
}

export async function startServer(store = new ConfigStore()): Promise<{ server: Server; adminServer: Server; close: () => Promise<void> }> { const created = await createApplication(store); const server = created.mcpApp.listen(created.config.mcp.port, created.config.mcp.host); const adminServer = created.adminApp.listen(created.config.admin.port, created.config.admin.host); const closeServer = (target: Server) => new Promise<void>((resolve, reject) => target.close((error) => error ? reject(error) : resolve())); return { server, adminServer, close: async () => { await created.close(); await Promise.all([closeServer(server), closeServer(adminServer)]); } }; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function requireAdminRequest(req: Request, auth: AuthService, csrf: string): void { if (req.headers["x-csrf-token"] !== csrf || !auth.requireOwner(bearer(req))) throw new AppError("UNAUTHORIZED", "Owner token and CSRF token required", 401); }
function adminHtml(csrf: string): string { return `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Secure Host MCP</title><style>body{font:16px system-ui;max-width:900px;margin:3rem auto;padding:0 1rem;background:#0b1020;color:#e8edf7}input,button{font:inherit;padding:.65rem;margin:.3rem}pre{white-space:pre-wrap;background:#151d33;padding:1rem;border-radius:.5rem}.warn{color:#ffcc66}</style><h1>Secure Host MCP</h1><p class="warn">Public HTTP is not encrypted. Authentication protects access but cannot prevent network interception of the owner token or administration traffic. Use HTTPS or a trusted private network.</p><input id="token" type="password" placeholder="Owner token"><button onclick="loadStatus()">Load status</button><button onclick="loadTokens()">Tokens</button><input id="label" placeholder="New token label"><button onclick="createToken()">Create full-access token</button><pre id="out">Not authenticated.</pre><script>const csrf=${JSON.stringify(csrf)};const headers=()=>({Authorization:'Bearer '+document.querySelector('#token').value,'Content-Type':'application/json','X-CSRF-Token':csrf});async function show(r){document.querySelector('#out').textContent=JSON.stringify(await r.json(),null,2)}async function loadStatus(){await show(await fetch('/api/status',{headers:headers()}))}async function loadTokens(){await show(await fetch('/api/tokens',{headers:headers()}))}async function createToken(){await show(await fetch('/api/tokens',{method:'POST',headers:headers(),body:JSON.stringify({label:document.querySelector('#label').value})}))}</script></html>`; }
