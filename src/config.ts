import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ALL_SCOPES, AppError, type Scope } from "./types.js";

const NonEmptyTokenSchema = z.string().refine((value) => value.trim().length > 0, "token must not be empty");
const ConfiguredTokenSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/).optional(),
  token: NonEmptyTokenSchema,
  label: z.string().max(120).default("Configured agent token"),
  scopes: z.array(z.enum(ALL_SCOPES)).default([...ALL_SCOPES]),
  createdAt: z.string().datetime().optional()
});
const TokenConfigSchema = z.object({
  version: z.literal(1).default(1),
  adminToken: NonEmptyTokenSchema,
  connectionTokens: z.array(ConfiguredTokenSchema).default([])
}).superRefine((config, context) => {
  const ids = new Set<string>();
  const tokens = new Set([config.adminToken]);
  config.connectionTokens.forEach((record, index) => {
    if (record.id === "admin") context.addIssue({ code: "custom", path: ["connectionTokens", index, "id"], message: "token id admin is reserved" });
    if (record.id && ids.has(record.id)) context.addIssue({ code: "custom", path: ["connectionTokens", index, "id"], message: "token id must be unique" });
    if (tokens.has(record.token)) context.addIssue({ code: "custom", path: ["connectionTokens", index, "token"], message: "token value must be unique" });
    if (record.id) ids.add(record.id);
    tokens.add(record.token);
  });
});

const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  dataDir: z.string(),
  publicBaseUrl: z.string().url().optional(),
  mcp: z.object({ host: z.string().default("0.0.0.0"), port: z.number().int().min(1).max(65535).default(8767) }),
  admin: z.object({ host: z.string().default("0.0.0.0"), port: z.number().int().min(1).max(65535).default(8768) }),
  execution: z.object({ maxTimeoutMs: z.number().int().positive().default(120000), maxOutputBytes: z.number().int().positive().default(1048576), maxJobs: z.number().int().positive().default(8), jobTtlMs: z.number().int().positive().default(3600000), shell: z.string().optional() }),
  audit: z.object({ retentionDays: z.number().int().positive().default(30), maxFileBytes: z.number().int().positive().default(25 * 1024 * 1024) }),
  auth: z.object({ externalIssuer: z.string().url().optional(), externalAudience: z.string().optional() }).default({}),
  tunnels: z.object({ cloudflaredConfig: z.string().optional(), frpcConfig: z.string().optional(), proxyUrl: z.string().optional() }).default({}),
  network: z.object({ hasPublicIp: z.boolean().optional(), publicAddress: z.string().optional() }).default({}),
  legacySse: z.boolean().default(false),
  adminMode: z.boolean().default(false)
});

const SecretsSchema = z.object({
  helperKey: z.string().optional(),
  oauth: z.object({ clients: z.array(z.record(z.unknown())).default([]), grants: z.array(z.record(z.unknown())).default([]) }).default({ clients: [], grants: [] })
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type Secrets = z.infer<typeof SecretsSchema>;
export type ConfiguredToken = z.infer<typeof ConfiguredTokenSchema>;
export type TokenConfig = z.infer<typeof TokenConfigSchema>;

export function defaultDataDir(): string {
  return process.env.SECURE_HOST_MCP_HOME ?? path.join(os.homedir(), ".secure-host-mcp");
}

async function atomicWrite(file: string, value: unknown, secret = false): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: secret ? 0o600 : 0o644 });
  await rename(temp, file);
  if (secret && process.platform !== "win32") await chmod(file, 0o600);
}

export class ConfigStore {
  readonly configPath: string;
  readonly secretsPath: string;
  readonly tokensPath: string;
  constructor(readonly dataDir = defaultDataDir()) {
    this.configPath = path.join(dataDir, "config.json");
    this.secretsPath = path.join(dataDir, "secrets.json");
    this.tokensPath = path.join(dataDir, "tokens.json");
  }

  async loadConfig(): Promise<AppConfig> {
    try { return ConfigSchema.parse(JSON.parse(await readFile(this.configPath, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return ConfigSchema.parse({ dataDir: this.dataDir, mcp: {}, admin: {}, execution: {}, audit: {} });
    }
  }

  async saveConfig(config: AppConfig): Promise<void> { await atomicWrite(this.configPath, ConfigSchema.parse(config)); }

  async loadSecrets(): Promise<Secrets> {
    try {
      if (process.platform !== "win32" && ((await stat(this.secretsPath)).mode & 0o077) !== 0) throw new AppError("INSECURE_SECRETS", "secrets.json must use mode 0600", 500);
      return SecretsSchema.parse(JSON.parse(await readFile(this.secretsPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return SecretsSchema.parse({});
    }
  }

  async saveSecrets(secrets: Secrets): Promise<void> { await atomicWrite(this.secretsPath, SecretsSchema.parse(secrets), true); }

  async loadTokenConfig(): Promise<TokenConfig | undefined> {
    try {
      if (process.platform !== "win32" && ((await stat(this.tokensPath)).mode & 0o077) !== 0) throw new AppError("INSECURE_TOKENS", "tokens.json must use mode 0600", 500);
      return TokenConfigSchema.parse(JSON.parse(await readFile(this.tokensPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }

  async saveTokenConfig(config: TokenConfig): Promise<void> { await atomicWrite(this.tokensPath, TokenConfigSchema.parse(config), true); }

  async hasAdminToken(): Promise<boolean> { return Boolean(await this.loadTokenConfig()); }

  async ensureAdminToken(requestedToken?: string): Promise<string | undefined> {
    if (await this.hasAdminToken()) return undefined;
    const token = requestedToken ?? randomBytes(32).toString("base64url");
    await this.saveTokenConfig({ version: 1, adminToken: token, connectionTokens: [] });
    return token;
  }

  async ensureHelperKey(): Promise<string> {
    const secrets = await this.loadSecrets();
    if (!secrets.helperKey) { secrets.helperKey = randomBytes(32).toString("base64url"); await this.saveSecrets(secrets); }
    return secrets.helperKey;
  }
}

export function hasScope(scopes: readonly Scope[], required: Scope): boolean { return scopes.includes(required); }
