export const ALL_SCOPES = [
  "system.read", "command.run", "command.elevate", "tunnel.read", "tunnel.manage", "admin.manage"
] as const;
export type Scope = (typeof ALL_SCOPES)[number];

export interface Principal {
  id: string;
  clientId: string;
  scopes: Scope[];
  method: "bearer" | "oauth" | "external-jwt";
}

export interface CommandRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  elevated?: boolean;
}

export interface CommandResult {
  correlationId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface SystemInfo {
  platform: NodeJS.Platform;
  arch: string;
  hostname: string;
  release: string;
  uptime: number;
  cpus: number;
  cpuModel?: string;
  totalMemory: number;
  freeMemory: number;
  node: string;
  uid?: number;
  elevated: boolean;
  configuredAdminMode: boolean;
}

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
