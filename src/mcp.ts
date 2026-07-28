import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { packageVersion } from "./version.js";
import type { AuditLog } from "./audit.js";
import { requireScope } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { CommandExecutor } from "./executor.js";
import { isProcessElevated } from "./executor.js";
import { AppError, type Principal } from "./types.js";
import type { TunnelManager } from "./tunnels.js";
import type { PrivilegeClient } from "./privilege.js";
import type { CodingWorkspace } from "./workspace.js";
import type { TerminalManager } from "./terminal.js";
import type { RuntimeAccess, RuntimeRecord } from "./runtime.js";

type Transport = StreamableHTTPServerTransport;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const RUNTIME_STATUS_URI = "ui://secure-host/runtime-status-v1.html";
const commandSchema = { command: z.string().min(1), cwd: z.string().optional(), env: z.record(z.string()).optional(), timeoutMs: z.number().int().positive().optional() };
const asText = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : { value }
});
const workspaceChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), path: z.string().min(1), content: z.string(), expectedSha256: z.string().optional() }),
  z.object({ type: z.literal("replace"), path: z.string().min(1), oldText: z.string().min(1), newText: z.string(), expectedSha256: z.string().optional() }),
  z.object({ type: z.literal("delete"), path: z.string().min(1), expectedSha256: z.string().optional() })
]);

export class McpHost {
  private readonly transports = new Map<string, Transport>();
  private readonly legacyTransports = new Map<string, SSEServerTransport>();
  constructor(private readonly config: AppConfig, private readonly executor: CommandExecutor, private readonly terminals: TerminalManager, private readonly tunnels: TunnelManager, private readonly audit: AuditLog, private readonly privilege: PrivilegeClient, private readonly workspace: CodingWorkspace) {}

  private createServer(principal: Principal): McpServer {
    const server = new McpServer({ name: "secure-host-mcp", version: packageVersion() });
    server.registerTool("system_info", { description: "Read host system and privilege information", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, async () => { requireScope(principal, "system.read"); return asText(this.executor.systemInfo()); });
    server.registerTool("execute_command", { description: "Execute one command as the MCP service account", inputSchema: commandSchema, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async (input) => {
      requireScope(principal, "command.run"); const result = await this.executor.execute(input); await this.audit.write({ correlationId: result.correlationId, action: "command.execute", principalId: principal.id, success: result.exitCode === 0, command: input.command, stdout: result.stdout, stderr: result.stderr, metadata: { exitCode: result.exitCode, timedOut: result.timedOut } }); return asText(result);
    });
    server.registerTool("start_job", { description: "Start a tracked background command", inputSchema: commandSchema, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async (input) => { requireScope(principal, "command.run"); const result = await this.executor.start(input, async (completed) => { await this.audit.write({ correlationId: completed.correlationId, action: "job.complete", principalId: principal.id, success: completed.exitCode === 0, command: input.command, stdout: completed.stdout, stderr: completed.stderr, metadata: { exitCode: completed.exitCode, truncated: completed.truncated } }); }, this.runtimeAccess(principal)); await this.audit.write({ correlationId: result.correlationId, action: "job.start", principalId: principal.id, success: true, command: input.command }); return asText(result); });
    server.registerTool("job_status", { description: "Read tracked background job status", inputSchema: { jobId: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ jobId }) => { requireScope(principal, "command.run"); return asText(await this.runtimeOperation(principal, "job.status", jobId, () => this.executor.status(jobId, this.runtimeAccess(principal)))); });
    server.registerTool("read_job_output", { description: "Read background job output from an offset", inputSchema: { jobId: z.string().uuid(), offset: z.number().int().nonnegative().default(0) }, annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ jobId, offset }) => { requireScope(principal, "command.run"); return asText(await this.runtimeOperation(principal, "job.read", jobId, () => this.executor.output(jobId, offset, this.runtimeAccess(principal)))); });
    server.registerTool("write_job_input", { description: "Write UTF-8 input to a running background job and optionally close stdin", inputSchema: { jobId: z.string().uuid(), data: z.string().default(""), close: z.boolean().default(false) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ jobId, data, close }) => { requireScope(principal, "command.run"); return asText(await this.runtimeOperation(principal, "job.write", jobId, () => this.executor.writeInput(jobId, data, close, this.runtimeAccess(principal)))); });
    server.registerTool("cancel_job", { description: "Cancel a tracked background job", inputSchema: { jobId: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async ({ jobId }) => { requireScope(principal, "command.run"); await this.runtimeOperation(principal, "job.cancel", jobId, () => this.executor.cancel(jobId, this.runtimeAccess(principal))); await this.audit.write({ correlationId: randomUUID(), action: "job.cancel", principalId: principal.id, success: true, metadata: { jobId } }); return asText({ cancelled: true, jobId }); });
    this.registerTerminalTools(server, principal);
    this.registerRuntimeSnapshot(server, principal);
    server.registerTool("execute_elevated", { description: "Execute a command through administrator mode or the privileged helper", inputSchema: commandSchema, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async (input) => { requireScope(principal, "command.elevate"); const result = isProcessElevated() ? await this.executor.execute({ ...input, elevated: true }) : await this.privilege.execute({ ...input, elevated: true }); await this.audit.write({ correlationId: result.correlationId, action: "command.elevated", principalId: principal.id, success: result.exitCode === 0, command: input.command, stdout: result.stdout, stderr: result.stderr }); return asText(result); });
    server.registerTool("set_admin_mode", { description: "Restart the whole MCP as root/SYSTEM through the privileged helper, or request local service-account restoration.", inputSchema: { enabled: z.boolean(), acknowledgement: z.literal("I understand this gives the Agent full host control") }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async ({ enabled }) => { requireScope(principal, "admin.manage"); const correlationId = randomUUID(); await this.audit.write({ correlationId, action: "admin-mode.request", principalId: principal.id, success: true, metadata: { enabled } }); if (!enabled) return asText({ requested: false, enabled, message: "Safe privilege drop requires restoring the configured systemd/Windows Service account locally, then restarting." }); if (isProcessElevated()) return asText({ requested: false, enabled: true, message: "This MCP process is already elevated." }); await this.privilege.restartAsAdministrator(); return asText({ requested: true, enabled: true, message: "The privileged helper accepted the request; this MCP instance will restart elevated." }); });
    if (this.config.coding.enabled) this.registerCodingTools(server, principal);
    server.registerTool("tunnel_inspect", { description: "Inspect cloudflared and frpc installation/configuration with secrets redacted", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, async () => { requireScope(principal, "tunnel.read"); return asText(await this.tunnels.inspect()); });
    server.registerTool("tunnel_start", { description: "Start a configured tunnel client", inputSchema: { kind: z.enum(["cloudflared", "frpc"]) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async ({ kind }) => { requireScope(principal, "tunnel.manage"); return asText(await this.tunnels.start(kind)); });
    server.registerTool("tunnel_stop", { description: "Stop a tunnel client started by this service", inputSchema: { kind: z.enum(["cloudflared", "frpc"]) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async ({ kind }) => { requireScope(principal, "tunnel.manage"); this.tunnels.stop(kind); return asText({ stopped: true, kind }); });
    return server;
  }

  private registerTerminalTools(server: McpServer, principal: Principal): void {
    const idSchema = z.string().uuid();
    server.registerTool("create_terminal", {
      description: "Create a persistent interactive PTY terminal session",
      inputSchema: { cwd: z.string().optional(), env: z.record(z.string()).optional(), cols: z.number().int().min(20).max(500).default(120), rows: z.number().int().min(5).max(300).default(30) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    }, async (input) => {
      requireScope(principal, "command.run");
      return asText(await this.terminals.create(input, this.runtimeAccess(principal)));
    });
    server.registerTool("read_terminal", {
      description: "Read bounded PTY output from a monotonic byte offset",
      inputSchema: { terminalId: idSchema, offset: z.number().int().nonnegative().default(0), maxBytes: z.number().int().positive().max(16 * 1024 * 1024).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    }, async ({ terminalId, offset, maxBytes }) => {
      requireScope(principal, "command.run");
      return asText(await this.runtimeOperation(principal, "terminal.read", terminalId, () => this.terminals.read(terminalId, offset, maxBytes, this.runtimeAccess(principal))));
    });
    server.registerTool("write_terminal", {
      description: "Write UTF-8 input to a running PTY terminal",
      inputSchema: { terminalId: idSchema, data: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    }, async ({ terminalId, data }) => {
      requireScope(principal, "command.run");
      return asText(await this.runtimeOperation(principal, "terminal.write", terminalId, () => this.terminals.write(terminalId, data, this.runtimeAccess(principal))));
    });
    server.registerTool("resize_terminal", {
      description: "Resize a running PTY terminal",
      inputSchema: { terminalId: idSchema, cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(300) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    }, async ({ terminalId, cols, rows }) => {
      requireScope(principal, "command.run");
      return asText(await this.runtimeOperation(principal, "terminal.resize", terminalId, () => this.terminals.resize(terminalId, cols, rows, this.runtimeAccess(principal))));
    });
    server.registerTool("interrupt_terminal", {
      description: "Send Ctrl+C to a running PTY terminal",
      inputSchema: { terminalId: idSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    }, async ({ terminalId }) => {
      requireScope(principal, "command.run");
      return asText(await this.runtimeOperation(principal, "terminal.interrupt", terminalId, () => this.terminals.interrupt(terminalId, this.runtimeAccess(principal))));
    });
    server.registerTool("close_terminal", {
      description: "Close a PTY terminal session",
      inputSchema: { terminalId: idSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    }, async ({ terminalId }) => {
      requireScope(principal, "command.run");
      return asText(await this.runtimeOperation(principal, "terminal.close", terminalId, () => this.terminals.close(terminalId, this.runtimeAccess(principal))));
    });
  }

  private registerRuntimeSnapshot(server: McpServer, principal: Principal): void {
    registerAppTool(server, "runtime_snapshot", {
      title: "Secure Host runtime status",
      description: "Show a read-only snapshot of this host, accessible jobs and terminals, and coding workspace Git state",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: RUNTIME_STATUS_URI } }
    }, async () => {
      requireScope(principal, "system.read");
      const access = this.runtimeAccess(principal);
      const snapshot: Record<string, unknown> = {
        generatedAt: new Date().toISOString(),
        host: this.executor.systemInfo()
      };
      if (principal.scopes.includes("command.run")) {
        const visibleRecord = (record: RuntimeRecord): Record<string, unknown> => {
          if (access.canManageAll) return record;
          const { ownerId: _ownerId, ...visible } = record;
          void _ownerId;
          return visible;
        };
        snapshot.jobs = this.executor.list(access).map(visibleRecord);
        snapshot.terminals = this.terminals.list(access).map(visibleRecord);
      }
      if (this.config.coding.enabled && principal.scopes.includes("workspace.read")) {
        snapshot.workspace = await this.workspace.snapshot();
      }
      return asText(snapshot);
    });
    registerAppResource(server, "Secure Host runtime status card", RUNTIME_STATUS_URI, {
      mimeType: RESOURCE_MIME_TYPE,
      description: "Read-only Secure Host runtime status card"
    }, async () => ({
      contents: [{
        uri: RUNTIME_STATUS_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: runtimeStatusHtml()
      }]
    }));
  }

  private runtimeAccess(principal: Principal): RuntimeAccess {
    return { principalId: principal.id, canManageAll: principal.scopes.includes("admin.manage") };
  }

  private async runtimeOperation<T>(principal: Principal, action: string, objectId: string, operation: () => T | Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AppError && (error.code === "JOB_NOT_FOUND" || error.code === "TERMINAL_NOT_FOUND")) {
        await this.audit.write({
          correlationId: randomUUID(),
          action: `${action}.denied`,
          principalId: principal.id,
          success: false,
          metadata: { objectId }
        });
      }
      throw error;
    }
  }

  private registerCodingTools(server: McpServer, principal: Principal): void {
    server.registerTool("workspace_info", { description: "Show the configured coding workspace and its limits", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, async () => {
      requireScope(principal, "workspace.read"); return asText(this.workspace.info());
    });
    server.registerTool("read_file", { description: "Read a bounded UTF-8 file range inside the coding workspace", inputSchema: { path: z.string().min(1), startLine: z.number().int().positive().optional(), maxLines: z.number().int().positive().max(5000).optional(), maxBytes: z.number().int().positive().optional() }, annotations: { readOnlyHint: true, openWorldHint: false } }, async (input) => {
      requireScope(principal, "workspace.read"); return asText(await this.workspace.readFile(input));
    });
    server.registerTool("list_directory", { description: "List entries inside the coding workspace without following symbolic links", inputSchema: { path: z.string().default("."), recursive: z.boolean().default(false), maxDepth: z.number().int().positive().max(20).default(3), maxEntries: z.number().int().positive().max(5000).default(1000), includeHidden: z.boolean().default(false) }, annotations: { readOnlyHint: true, openWorldHint: false } }, async (input) => {
      requireScope(principal, "workspace.read"); return asText(await this.workspace.listDirectory(input));
    });
    server.registerTool("list_files", { description: "Recursively list coding-workspace files with an optional glob", inputSchema: { path: z.string().default("."), glob: z.string().optional(), maxResults: z.number().int().positive().max(5000).default(1000), includeHidden: z.boolean().default(false) }, annotations: { readOnlyHint: true, openWorldHint: false } }, async (input) => {
      requireScope(principal, "workspace.read"); return asText(await this.workspace.listFiles(input));
    });
    server.registerTool("search_text", { description: "Search UTF-8 files in the coding workspace using literal text or a regular expression", inputSchema: { query: z.string().min(1), path: z.string().default("."), regex: z.boolean().default(false), caseSensitive: z.boolean().default(false), glob: z.string().optional(), maxResults: z.number().int().positive().max(5000).optional() }, annotations: { readOnlyHint: true, openWorldHint: false } }, async (input) => {
      requireScope(principal, "workspace.read"); return asText(await this.workspace.searchText(input));
    });
    server.registerTool("apply_patch", { description: "Atomically create, uniquely replace, or delete files inside the coding workspace", inputSchema: { changes: z.array(workspaceChangeSchema).min(1).max(100), dryRun: z.boolean().default(false) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, async ({ changes, dryRun }) => {
      requireScope(principal, "workspace.write");
      const result = await this.workspace.applyPatch({ changes, dryRun });
      await this.audit.write({ correlationId: randomUUID(), action: "workspace.patch", principalId: principal.id, success: true, metadata: { dryRun, changes: result.changed } });
      return asText(result);
    });
    server.registerTool("git_status", { description: "Read Git working-tree status for the coding workspace", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, async () => {
      requireScope(principal, "workspace.read"); return asText(await this.workspace.gitStatus());
    });
    server.registerTool("git_diff", { description: "Read a bounded staged or unstaged Git diff", inputSchema: { staged: z.boolean().default(false), path: z.string().optional(), contextLines: z.number().int().nonnegative().max(20).default(3), maxBytes: z.number().int().positive().optional() }, annotations: { readOnlyHint: true, openWorldHint: false } }, async (input) => {
      requireScope(principal, "workspace.read"); return asText(await this.workspace.gitDiff(input));
    });
    server.registerTool("git_log", { description: "Read bounded Git commit history for the coding workspace", inputSchema: { maxCount: z.number().int().positive().max(100).default(20), skip: z.number().int().nonnegative().default(0), path: z.string().optional() }, annotations: { readOnlyHint: true, openWorldHint: false } }, async (input) => {
      requireScope(principal, "workspace.read"); return asText(await this.workspace.gitLog(input));
    });
    server.registerTool("git_show", { description: "Show a bounded Git revision and patch", inputSchema: { revision: z.string().default("HEAD"), maxBytes: z.number().int().positive().optional() }, annotations: { readOnlyHint: true, openWorldHint: false } }, async (input) => {
      requireScope(principal, "workspace.read"); return asText(await this.workspace.gitShow(input));
    });
    server.registerTool("git_blame", { description: "Read bounded Git line attribution for one workspace file", inputSchema: { path: z.string().min(1), startLine: z.number().int().positive().default(1), endLine: z.number().int().positive().optional() }, annotations: { readOnlyHint: true, openWorldHint: false } }, async (input) => {
      requireScope(principal, "workspace.read"); return asText(await this.workspace.gitBlame(input));
    });
  }

  handlePost = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined; let transport = sessionId ? this.transports.get(sessionId) : undefined;
    if (!transport && !sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => { this.transports.set(id, transport!); } });
      transport.onclose = () => { if (transport?.sessionId) this.transports.delete(transport.sessionId); };
      await this.createServer(req.principal!).connect(transport); await transport.handleRequest(req, res, req.body); return;
    }
    if (!transport) { res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid MCP session" }, id: null }); return; }
    await transport.handleRequest(req, res, req.body);
  };
  handleGet = async (req: Request, res: Response): Promise<void> => { const transport = this.transports.get(String(req.headers["mcp-session-id"] ?? "")); if (!transport) { res.status(400).send("Invalid MCP session"); return; } await transport.handleRequest(req, res); };
  handleDelete = this.handleGet;
  handleLegacyGet = async (req: Request, res: Response): Promise<void> => { const transport = new SSEServerTransport("/messages", res); this.legacyTransports.set(transport.sessionId, transport); res.on("close", () => this.legacyTransports.delete(transport.sessionId)); await this.createServer(req.principal!).connect(transport); };
  handleLegacyPost = async (req: Request, res: Response): Promise<void> => { const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : ""; const transport = this.legacyTransports.get(sessionId); if (!transport) { res.status(400).send("Invalid legacy SSE session"); return; } await transport.handlePostMessage(req, res, req.body); };
  async close(): Promise<void> { await Promise.all([...this.transports.values(), ...this.legacyTransports.values()].map((transport) => transport.close())); this.transports.clear(); this.legacyTransports.clear(); }
}

function runtimeStatusHtml(): string {
  const candidates = [
    join(moduleDirectory, "../web/runtime-status.html"),
    join(moduleDirectory, "web/runtime-status.html")
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new AppError("MCP_APP_ASSET_MISSING", "web/runtime-status.html was not found in the application package", 500);
}
