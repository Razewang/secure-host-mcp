import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppConfig, ConfigStore, Secrets, TokenConfig, TokenRecord } from "./config.js";
import { hashToken, tokenMatches } from "./config.js";
import { ALL_SCOPES, AppError, type Principal, type Scope } from "./types.js";

interface OAuthClient { client_id: string; client_secret?: string; client_name: string; redirect_uris: string[]; created_at: number; }
interface OAuthGrant { kind: "code" | "access" | "refresh"; tokenHash: string; clientId: string; redirectUri?: string; scopes: Scope[]; expiresAt: number; codeChallenge?: string; used?: boolean; }

declare global { namespace Express { interface Request { principal?: Principal; } } }

function opaque(): string { return randomBytes(32).toString("base64url"); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function configuredTokenMatches(actual: string, expected: string): boolean {
  const actualDigest = Buffer.from(digest(actual), "hex");
  const expectedDigest = Buffer.from(digest(expected), "hex");
  return timingSafeEqual(actualDigest, expectedDigest);
}
function isScope(value: string): value is Scope { return (ALL_SCOPES as readonly string[]).includes(value); }

export class AuthService {
  private secrets!: Secrets;
  private tokenConfig?: TokenConfig;
  private externalJwksUri?: string;
  constructor(private readonly config: AppConfig, private readonly store: ConfigStore) {}
  async initialize(): Promise<void> {
    this.secrets = await this.store.loadSecrets();
    this.tokenConfig = await this.store.loadTokenConfig();
    if (this.config.auth.externalIssuer) {
      const issuer = this.config.auth.externalIssuer.replace(/\/$/, "");
      const response = await fetch(`${issuer}/.well-known/openid-configuration`);
      if (!response.ok) throw new AppError("OIDC_DISCOVERY", `external OIDC discovery failed: ${response.status}`, 500);
      const metadata = await response.json() as { issuer?: string; jwks_uri?: string };
      if (metadata.issuer?.replace(/\/$/, "") !== issuer || !metadata.jwks_uri) throw new AppError("OIDC_DISCOVERY", "external OIDC metadata has an invalid issuer or missing jwks_uri", 500);
      this.externalJwksUri = metadata.jwks_uri;
    }
  }
  private clients(): OAuthClient[] { return this.secrets.oauth.clients as unknown as OAuthClient[]; }
  private grants(): OAuthGrant[] { return this.secrets.oauth.grants as unknown as OAuthGrant[]; }
  private async persist(): Promise<void> { await this.store.saveSecrets(this.secrets); }

  async authenticate(token: string): Promise<Principal> {
    if (this.tokenConfig && configuredTokenMatches(token, this.tokenConfig.adminToken)) return { id: "owner", clientId: "owner", scopes: [...ALL_SCOPES], method: "bearer" };
    const configuredIndex = this.tokenConfig?.connectionTokens.findIndex((record) => configuredTokenMatches(token, record.token)) ?? -1;
    const configured = configuredIndex >= 0 ? this.tokenConfig?.connectionTokens[configuredIndex] : undefined;
    if (configured) {
      return { id: `configured:${configuredIndex + 1}`, clientId: `configured:${configuredIndex + 1}`, scopes: configured.scopes, method: "bearer" };
    }
    const local = this.secrets.tokens.find((record) => (!this.tokenConfig || record.id !== "owner") && tokenMatches(token, record));
    if (local) return { id: local.id, clientId: local.id, scopes: local.scopes, method: "bearer" };
    const grant = this.grants().find((item) => item.kind === "access" && item.tokenHash === digest(token) && item.expiresAt > Date.now());
    if (grant) return { id: `oauth:${grant.clientId}`, clientId: grant.clientId, scopes: grant.scopes, method: "oauth" };
    if (this.config.auth.externalIssuer) {
      if (!this.externalJwksUri) throw new AppError("OIDC_DISCOVERY", "external OIDC JWKS is unavailable", 500);
      const jwks = createRemoteJWKSet(new URL(this.externalJwksUri));
      const verified = await jwtVerify(token, jwks, { issuer: this.config.auth.externalIssuer, ...(this.config.auth.externalAudience ? { audience: this.config.auth.externalAudience } : {}) });
      const rawScopes = typeof verified.payload.scope === "string" ? verified.payload.scope.split(" ") : [];
      const clientClaim = verified.payload.client_id ?? verified.payload.azp;
      return { id: typeof verified.payload.sub === "string" ? verified.payload.sub : "external", clientId: typeof clientClaim === "string" ? clientClaim : "external", scopes: rawScopes.filter(isScope), method: "external-jwt" };
    }
    throw new AppError("UNAUTHORIZED", "invalid or expired token", 401);
  }

  middleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) throw new AppError("UNAUTHORIZED", "Bearer token required", 401);
      req.principal = await this.authenticate(header.slice(7)); next();
    } catch (error) {
      res.status(error instanceof AppError ? error.status : 401).set("WWW-Authenticate", `Bearer resource_metadata="${this.baseUrl()}/.well-known/oauth-protected-resource"`).json({ error: "unauthorized" });
    }
  };

  requireOwner(token: string): boolean {
    if (this.tokenConfig) return configuredTokenMatches(token, this.tokenConfig.adminToken);
    const owner = this.secrets.tokens.find((item) => item.id === "owner");
    return owner ? tokenMatches(token, owner) : false;
  }
  listTokens(): Record<string, unknown>[] {
    const configured = this.tokenConfig ? [
      { id: "owner", label: "Host owner", scopes: [...ALL_SCOPES], source: "tokens.json" },
      ...this.tokenConfig.connectionTokens.map((token, index) => ({ id: `configured:${index + 1}`, label: token.label, scopes: token.scopes, source: "tokens.json" }))
    ] : [];
    const managed = this.secrets.tokens.filter((record) => !this.tokenConfig || record.id !== "owner").map(tokenSummary);
    return [...configured, ...managed];
  }
  async createToken(label: string, scopes: Scope[]): Promise<{ id: string; token: string; scopes: Scope[] }> { const token = opaque(), salt = randomBytes(16).toString("hex"), id = randomUUID(); this.secrets.tokens.push({ id, label: label.slice(0, 120) || "Agent token", salt, hash: hashToken(token, salt), scopes, createdAt: new Date().toISOString() }); await this.persist(); return { id, token, scopes }; }
  async revokeToken(id: string): Promise<void> {
    if (id === "owner") throw new AppError("OWNER_TOKEN", "rotate the owner token in tokens.json instead of deleting it");
    if (id.startsWith("configured:")) throw new AppError("CONFIG_MANAGED_TOKEN", "remove configured tokens from tokens.json");
    this.secrets.tokens = this.secrets.tokens.filter((item) => item.id !== id);
    await this.persist();
  }
  baseUrl(): string { return this.config.publicBaseUrl ?? `http://${this.config.mcp.host}:${this.config.mcp.port}`; }
  metadata(): Record<string, unknown> { return { issuer: this.baseUrl(), authorization_endpoint: `${this.baseUrl()}/oauth/authorize`, token_endpoint: `${this.baseUrl()}/oauth/token`, revocation_endpoint: `${this.baseUrl()}/oauth/revoke`, registration_endpoint: `${this.baseUrl()}/oauth/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], scopes_supported: [...ALL_SCOPES, "offline_access"] }; }
  resourceMetadata(): Record<string, unknown> { return { resource: `${this.baseUrl()}/mcp`, authorization_servers: [this.baseUrl()], scopes_supported: [...ALL_SCOPES] }; }

  async registerClient(body: unknown): Promise<Record<string, unknown>> {
    const input = body as Record<string, unknown>; const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((v): v is string => typeof v === "string") : [];
    if (!uris.length || uris.some((uri) => !this.validRedirect(uri))) throw new AppError("INVALID_REDIRECT", "valid redirect_uris are required");
    const method = input.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none";
    const client: OAuthClient = { client_id: randomUUID(), ...(method === "client_secret_post" ? { client_secret: opaque() } : {}), client_name: typeof input.client_name === "string" ? input.client_name.slice(0, 120) : "MCP client", redirect_uris: uris, created_at: Date.now() };
    this.clients().push(client); await this.persist(); return { ...client, client_id_issued_at: Math.floor(client.created_at / 1000), token_endpoint_auth_method: method };
  }

  getClient(id: string): OAuthClient | undefined { return this.clients().find((client) => client.client_id === id); }
  async issueCode(input: { clientId: string; redirectUri: string; scope: string; challenge: string }): Promise<string> {
    const client = this.getClient(input.clientId); if (!client?.redirect_uris.includes(input.redirectUri)) throw new AppError("INVALID_CLIENT", "unknown client or redirect URI");
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(input.challenge)) throw new AppError("INVALID_PKCE", "a valid S256 code_challenge is required");
    const scopes = input.scope.split(" ").filter(isScope); const code = opaque();
    this.grants().push({ kind: "code", tokenHash: digest(code), clientId: input.clientId, redirectUri: input.redirectUri, scopes, expiresAt: Date.now() + 300000, codeChallenge: input.challenge }); await this.persist(); return code;
  }

  async exchange(params: URLSearchParams): Promise<Record<string, unknown>> {
    const grantType = params.get("grant_type"); const clientId = params.get("client_id") ?? ""; const client = this.getClient(clientId);
    if (!client || (client.client_secret && params.get("client_secret") !== client.client_secret)) throw new AppError("INVALID_CLIENT", "client authentication failed", 401);
    if (grantType === "authorization_code") {
      const grant = this.grants().find((item) => item.kind === "code" && item.tokenHash === digest(params.get("code") ?? "") && !item.used && item.expiresAt > Date.now());
      const verifier = params.get("code_verifier") ?? ""; if (!grant || grant.clientId !== clientId || grant.redirectUri !== params.get("redirect_uri") || digestBase64(verifier) !== grant.codeChallenge) throw new AppError("INVALID_GRANT", "invalid authorization code");
      grant.used = true; return await this.createTokens(clientId, grant.scopes);
    }
    if (grantType === "refresh_token") {
      const refresh = this.grants().find((item) => item.kind === "refresh" && item.tokenHash === digest(params.get("refresh_token") ?? "") && item.expiresAt > Date.now() && !item.used);
      if (!refresh || refresh.clientId !== clientId) throw new AppError("INVALID_GRANT", "invalid refresh token"); refresh.used = true; return await this.createTokens(clientId, refresh.scopes);
    }
    throw new AppError("UNSUPPORTED_GRANT", "unsupported grant_type");
  }

  async revoke(token: string): Promise<void> { const grant = this.grants().find((item) => item.tokenHash === digest(token)); if (grant) { grant.expiresAt = 0; grant.used = true; await this.persist(); } }
  private async createTokens(clientId: string, scopes: Scope[]): Promise<Record<string, unknown>> { const access = opaque(), refresh = opaque(); this.grants().push({ kind: "access", tokenHash: digest(access), clientId, scopes, expiresAt: Date.now() + 3600000 }, { kind: "refresh", tokenHash: digest(refresh), clientId, scopes, expiresAt: Date.now() + 30 * 86400000 }); await this.persist(); return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: [...scopes, "offline_access"].join(" ") }; }
  private validRedirect(uri: string): boolean { try { const url = new URL(uri); return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)); } catch { return false; } }
}

function digestBase64(value: string): string { return createHash("sha256").update(value).digest("base64url"); }
export function requireScope(principal: Principal | undefined, scope: Scope): Principal { if (!principal?.scopes.includes(scope)) throw new AppError("FORBIDDEN", `scope required: ${scope}`, 403); return principal; }
export function tokenSummary(record: TokenRecord): Record<string, unknown> { return { id: record.id, label: record.label, scopes: record.scopes, createdAt: record.createdAt }; }
