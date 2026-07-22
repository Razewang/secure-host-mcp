import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { z } from "zod";
import type { AuditLog } from "./audit.js";
import { requireScope } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { CommandExecutor } from "./executor.js";
import { isProcessElevated } from "./executor.js";
import type { Principal } from "./types.js";
import type { TunnelManager } from "./tunnels.js";
import type { PrivilegeClient } from "./privilege.js";

type Transport = StreamableHTTPServerTransport;
const commandSchema = { command: z.string().min(1), cwd: z.string().optional(), env: z.record(z.string()).optional(), timeoutMs: z.number().int().positive().optional() };
const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export class McpHost {
  private readonly transports = new Map<string, Transport>();
  private readonly legacyTransports = new Map<string, SSEServerTransport>();
  constructor(private readonly config: AppConfig, private readonly executor: CommandExecutor, private readonly tunnels: TunnelManager, private readonly audit: AuditLog, private readonly privilege: PrivilegeClient) {}

  private createServer(principal: Principal): McpServer {
    const server = new McpServer({ name: "secure-host-mcp", version: "0.1.0" });
    server.registerTool("system_info", { description: "Read host system and privilege information", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, async () => { requireScope(principal, "system.read"); return asText(this.executor.systemInfo()); });
    server.registerTool("execute_command", { description: "Execute one command as the MCP service account", inputSchema: commandSchema, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async (input) => {
      requireScope(principal, "command.run"); const result = await this.executor.execute(input); await this.audit.write({ correlationId: result.correlationId, action: "command.execute", principalId: principal.id, success: result.exitCode === 0, command: input.command, stdout: result.stdout, stderr: result.stderr, metadata: { exitCode: result.exitCode, timedOut: result.timedOut } }); return asText(result);
    });
    server.registerTool("start_job", { description: "Start a tracked background command", inputSchema: commandSchema, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async (input) => { requireScope(principal, "command.run"); const result = await this.executor.start(input, async (completed) => { await this.audit.write({ correlationId: completed.correlationId, action: "job.complete", principalId: principal.id, success: completed.exitCode === 0, command: input.command, stdout: completed.stdout, stderr: completed.stderr, metadata: { exitCode: completed.exitCode, truncated: completed.truncated } }); }); await this.audit.write({ correlationId: result.correlationId, action: "job.start", principalId: principal.id, success: true, command: input.command }); return asText(result); });
    server.registerTool("job_status", { description: "Read tracked background job status", inputSchema: { jobId: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ jobId }) => { requireScope(principal, "command.run"); return asText(this.executor.status(jobId)); });
    server.registerTool("read_job_output", { description: "Read background job output from an offset", inputSchema: { jobId: z.string().uuid(), offset: z.number().int().nonnegative().default(0) }, annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ jobId, offset }) => { requireScope(principal, "command.run"); return asText(this.executor.output(jobId, offset)); });
    server.registerTool("cancel_job", { description: "Cancel a tracked background job", inputSchema: { jobId: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, async ({ jobId }) => { requireScope(principal, "command.run"); this.executor.cancel(jobId); await this.audit.write({ correlationId: randomUUID(), action: "job.cancel", principalId: principal.id, success: true, metadata: { jobId } }); return asText({ cancelled: true, jobId }); });
    server.registerTool("execute_elevated", { description: "Execute a command through administrator mode or the privileged helper", inputSchema: commandSchema, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async (input) => { requireScope(principal, "command.elevate"); const result = isProcessElevated() ? await this.executor.execute({ ...input, elevated: true }) : await this.privilege.execute({ ...input, elevated: true }); await this.audit.write({ correlationId: result.correlationId, action: "command.elevated", principalId: principal.id, success: result.exitCode === 0, command: input.command, stdout: result.stdout, stderr: result.stderr }); return asText(result); });
    server.registerTool("set_admin_mode", { description: "Restart the whole MCP as root/SYSTEM through the privileged helper, or request local service-account restoration.", inputSchema: { enabled: z.boolean(), acknowledgement: z.literal("I understand this gives the Agent full host control") }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async ({ enabled }) => { requireScope(principal, "admin.manage"); const correlationId = randomUUID(); await this.audit.write({ correlationId, action: "admin-mode.request", principalId: principal.id, success: true, metadata: { enabled } }); if (!enabled) return asText({ requested: false, enabled, message: "Safe privilege drop requires restoring the configured systemd/Windows Service account locally, then restarting." }); if (isProcessElevated()) return asText({ requested: false, enabled: true, message: "This MCP process is already elevated." }); await this.privilege.restartAsAdministrator(); return asText({ requested: true, enabled: true, message: "The privileged helper accepted the request; this MCP instance will restart elevated." }); });
    server.registerTool("tunnel_inspect", { description: "Inspect cloudflared and frpc installation/configuration with secrets redacted", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, async () => { requireScope(principal, "tunnel.read"); return asText(await this.tunnels.inspect()); });
    server.registerTool("tunnel_start", { description: "Start a configured tunnel client", inputSchema: { kind: z.enum(["cloudflared", "frpc"]) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async ({ kind }) => { requireScope(principal, "tunnel.manage"); return asText(await this.tunnels.start(kind)); });
    server.registerTool("tunnel_stop", { description: "Stop a tunnel client started by this service", inputSchema: { kind: z.enum(["cloudflared", "frpc"]) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async ({ kind }) => { requireScope(principal, "tunnel.manage"); this.tunnels.stop(kind); return asText({ stopped: true, kind }); });
    return server;
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
