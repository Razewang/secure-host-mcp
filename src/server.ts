import { randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AuditLog } from "./audit.js";
import { AuthService } from "./auth.js";
import { ConfigStore, type AppConfig } from "./config.js";
import { CommandExecutor } from "./executor.js";
import { McpHost } from "./mcp.js";
import { ALL_SCOPES, AppError } from "./types.js";
import { TunnelManager, type TunnelInspection } from "./tunnels.js";
import { PrivilegeClient } from "./privilege.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const ADMIN_CSRF_PLACEHOLDER = "__SECURE_HOST_MCP_CSRF_TOKEN__";
const ADMIN_SCOPES_PLACEHOLDER = "__SECURE_HOST_MCP_SCOPES__";
const CreateTokenSchema = z.object({
  label: z.string().max(120).default("Agent token"),
  scopes: z.array(z.enum(ALL_SCOPES)).default([...ALL_SCOPES])
});
const TunnelParamsSchema = z.object({
  kind: z.enum(["frpc", "cloudflared"]),
  action: z.enum(["start", "stop"])
});

interface AdminStatus {
  system: ReturnType<CommandExecutor["systemInfo"]>;
  tunnels: TunnelInspection;
  config: Pick<AppConfig, "mcp" | "admin" | "publicBaseUrl" | "network" | "legacySse" | "adminMode">;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) { return (req: Request, res: Response, next: (error?: unknown) => void) => { void handler(req, res).catch(next); }; }
function bearer(req: Request): string { const value = req.headers.authorization; return value?.startsWith("Bearer ") ? value.slice(7) : ""; }

export async function createApplication(store = new ConfigStore()): Promise<{ mcpApp: express.Express; adminApp: express.Express; config: AppConfig; close: () => Promise<void> }> {
  const config = await store.loadConfig(); const auth = new AuthService(config, store); await auth.initialize(); const audit = new AuditLog(config); await audit.prune();
  const executor = new CommandExecutor(config); const tunnels = new TunnelManager(config); const mcp = new McpHost(config, executor, tunnels, audit, new PrivilegeClient(config, store));
  const mcpApp = express(); const adminApp = express();
  for (const app of [mcpApp, adminApp]) { app.disable("x-powered-by"); app.use(express.json({ limit: "1mb" })); app.use(express.urlencoded({ extended: false })); }
  const attempts = new Map<string, { count: number; resetAt: number }>();
  adminApp.use((req, res, next) => {
    const origin = req.headers.origin; const host = req.headers.host;
    if (origin && host) {
      try { if (new URL(origin).host !== host) { res.status(403).json({ error: "ORIGIN_REJECTED" }); return; } }
      catch { res.status(403).json({ error: "ORIGIN_REJECTED" }); return; }
    }
    const key = req.ip ?? "unknown", now = Date.now(), current = attempts.get(key); const item = !current || current.resetAt < now ? { count: 0, resetAt: now + 60000 } : current; item.count += 1; attempts.set(key, item); if (item.count > 120) { res.status(429).json({ error: "RATE_LIMITED" }); return; }
    res.set({ "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" }); next();
  });
  mcpApp.get("/.well-known/oauth-protected-resource", (_req, res) => res.json(auth.resourceMetadata()));
  mcpApp.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json(auth.resourceMetadata()));
  mcpApp.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(auth.metadata()));
  mcpApp.get("/.well-known/openid-configuration", (_req, res) => res.json(auth.metadata()));
  mcpApp.post("/oauth/register", asyncRoute(async (req, res) => { res.status(201).json(await auth.registerClient(req.body)); }));
  mcpApp.get("/oauth/authorize", (req, res) => {
    const p = new URLSearchParams(req.query as Record<string, string>); const client = auth.getClient(p.get("client_id") ?? "");
    if (!client || p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256") { res.status(400).send("Invalid OAuth authorization request"); return; }
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Authorize Secure Host MCP</title><h1>Authorize ${escapeHtml(client.client_name)}</h1><p>Redirect: ${escapeHtml(p.get("redirect_uri") ?? "")}</p><p>Scopes: ${escapeHtml(p.get("scope") ?? "")}</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${escapeHtml(Buffer.from(p.toString()).toString("base64url"))}"><label>Administrator token <input type="password" name="admin_token" required></label><button>Authorize</button></form>`);
  });
  mcpApp.post("/oauth/authorize", asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (!auth.requireAdmin(typeof body.admin_token === "string" ? body.admin_token : "")) throw new AppError("INVALID_ADMIN", "Administrator token is invalid", 401);
    const p = new URLSearchParams(Buffer.from(typeof body.request === "string" ? body.request : "", "base64url").toString()); if (p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256") throw new AppError("INVALID_REQUEST", "authorization code with PKCE S256 is required"); const code = await auth.issueCode({ clientId: p.get("client_id") ?? "", redirectUri: p.get("redirect_uri") ?? "", scope: p.get("scope") ?? "", challenge: p.get("code_challenge") ?? "" });
    const redirect = new URL(p.get("redirect_uri")!); redirect.searchParams.set("code", code); if (p.get("state")) redirect.searchParams.set("state", p.get("state")!); res.redirect(303, redirect.toString());
  }));
  mcpApp.post("/oauth/token", asyncRoute(async (req, res) => { res.json(await auth.exchange(new URLSearchParams(req.body as Record<string, string>))); }));
  mcpApp.post("/oauth/revoke", asyncRoute(async (req, res) => { const body = req.body as Record<string, unknown>; await auth.revoke(typeof body.token === "string" ? body.token : ""); res.status(200).end(); }));
  mcpApp.post("/mcp", auth.middleware, asyncRoute(mcp.handlePost)); mcpApp.get("/mcp", auth.middleware, asyncRoute(mcp.handleGet)); mcpApp.delete("/mcp", auth.middleware, asyncRoute(mcp.handleDelete));
  if (config.legacySse) { mcpApp.get("/sse", auth.middleware, asyncRoute(mcp.handleLegacyGet)); mcpApp.post("/messages", auth.middleware, asyncRoute(mcp.handleLegacyPost)); }

  const csrf = randomBytes(24).toString("base64url");
  adminApp.get("/", (_req, res) => res.type("html").send(adminHtml(csrf)));
  adminApp.get("/styles.css", (_req, res) => res.type("css").sendFile(adminWebFile("styles.css")));
  adminApp.get("/app.js", (_req, res) => res.type("js").sendFile(adminWebFile("app.js")));
  const requireAdminRead = adminAuthorization(auth, csrf, false);
  const requireAdminMutation = adminAuthorization(auth, csrf, true);
  adminApp.get("/api/status", requireAdminRead, asyncRoute(async (_req, res) => {
    const status: AdminStatus = {
      system: executor.systemInfo(),
      tunnels: await tunnels.inspect(),
      config: { mcp: config.mcp, admin: config.admin, publicBaseUrl: config.publicBaseUrl, network: config.network, legacySse: config.legacySse, adminMode: config.adminMode }
    };
    res.json(status);
  }));
  adminApp.get("/api/tokens", requireAdminRead, (_req, res) => { res.json(auth.listTokens()); });
  adminApp.post("/api/tokens", requireAdminMutation, asyncRoute(async (req, res) => {
    const input = CreateTokenSchema.parse(req.body);
    res.status(201).json(await auth.createToken(input.label, input.scopes));
  }));
  adminApp.delete("/api/tokens/:id", requireAdminMutation, asyncRoute(async (req, res) => { await auth.revokeToken(String(req.params.id)); res.status(204).end(); }));
  adminApp.post("/api/tunnels/:kind/:action", requireAdminMutation, asyncRoute(async (req, res) => {
    const params = TunnelParamsSchema.parse(req.params);
    if (params.action === "start") res.json(await tunnels.start(params.kind));
    else { tunnels.stop(params.kind); res.json({ stopped: true }); }
  }));
  const errorHandler = (error: unknown, _req: Request, res: Response, next: (error?: unknown) => void) => {
    void next;
    const appError = error instanceof AppError
      ? error
      : error instanceof z.ZodError
        ? new AppError("INVALID_REQUEST", error.issues.map((issue) => issue.message).join("; "), 400)
        : new AppError("INTERNAL", error instanceof Error ? error.message : "Internal error", 500);
    res.status(appError.status).json({ error: appError.code, message: appError.message });
  };
  mcpApp.use(errorHandler); adminApp.use(errorHandler);
  return { mcpApp, adminApp, config, close: () => mcp.close() };
}

export async function startServer(store = new ConfigStore()): Promise<{ server: Server; adminServer: Server; close: () => Promise<void> }> { const created = await createApplication(store); const server = created.mcpApp.listen(created.config.mcp.port, created.config.mcp.host); const adminServer = created.adminApp.listen(created.config.admin.port, created.config.admin.host); const closeServer = (target: Server) => new Promise<void>((resolve, reject) => target.close((error) => error ? reject(error) : resolve())); return { server, adminServer, close: async () => { await created.close(); await Promise.all([closeServer(server), closeServer(adminServer)]); } }; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function adminAuthorization(auth: AuthService, csrf: string, mutation: boolean) {
  return (req: Request, _res: Response, next: (error?: unknown) => void): void => {
    try {
      if (!auth.requireAdmin(bearer(req))) throw new AppError("UNAUTHORIZED", "Administrator Bearer token required", 401);
      if (mutation && req.headers["x-csrf-token"] !== csrf) throw new AppError("UNAUTHORIZED", "CSRF token required", 401);
      next();
    } catch (error) { next(error); }
  };
}
function adminWebFile(name: "index.html" | "styles.css" | "app.js"): string {
  const candidates = [join(moduleDirectory, `../web/${name}`), join(moduleDirectory, `web/${name}`)];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new AppError("ADMIN_ASSET_MISSING", `web/${name} was not found in the application package`, 500);
}
function adminHtml(csrf: string): string {
  const template = readFileSync(adminWebFile("index.html"), "utf8");
  for (const placeholder of [ADMIN_CSRF_PLACEHOLDER, ADMIN_SCOPES_PLACEHOLDER]) {
    if (template.split(placeholder).length !== 2) throw new AppError("ADMIN_TEMPLATE_INVALID", `Admin template must contain exactly one ${placeholder}`, 500);
  }
  return template
    .replace(ADMIN_CSRF_PLACEHOLDER, JSON.stringify(csrf))
    .replace(ADMIN_SCOPES_PLACEHOLDER, JSON.stringify(ALL_SCOPES));
}
