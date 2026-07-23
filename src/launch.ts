import { isIP } from "node:net";
import type { AppConfig, ConfigStore } from "./config.js";

function normalizedHost(host: string): string {
  const normalized = host.toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizedHost(host);
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (isIP(normalized) === 4) return normalized.split(".", 1)[0] === "127";
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return Boolean(mappedIpv4 && isIP(mappedIpv4) === 4 && mappedIpv4.split(".", 1)[0] === "127");
}

function bindUrl(host: string, port: number, pathname = "/"): string {
  const formattedHost = host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host;
  return `http://${formattedHost}:${port}${pathname}`;
}

export function enableLanHttp(config: AppConfig): void {
  config.admin.allowLanHttp = true;
  if (isLoopbackHost(config.admin.host)) config.admin.host = "0.0.0.0";
}

export function setupSummary(config: AppConfig): string[] {
  const messages = [
    `MCP bind: ${bindUrl(config.mcp.host, config.mcp.port, "/mcp")}`,
    `Administration bind: ${bindUrl(config.admin.host, config.admin.port)}`,
  ];
  if (!isLoopbackHost(config.mcp.host) || !isLoopbackHost(config.admin.host)) {
    messages.push("NETWORK: non-loopback listeners accept remote connections when the host firewall, router, and cloud security rules allow them.");
    messages.push("WARNING: authentication does not encrypt bearer tokens, OAuth codes, or administration traffic. Use HTTPS or a trusted private network for remote access.");
  }
  if (!config.publicBaseUrl?.startsWith("https://")) {
    messages.push("ChatGPT requires a public HTTPS MCP URL. Configure --public-url with an HTTPS reverse proxy, Cloudflare Tunnel, or frp endpoint.");
  }
  return messages;
}

export async function prepareInteractiveLaunch(store: ConfigStore): Promise<{ config: AppConfig; ownerToken?: string }> {
  const config = await store.loadConfig();
  await store.saveConfig(config);
  const ownerToken = await store.ensureOwnerToken();
  return { config, ...(ownerToken ? { ownerToken } : {}) };
}
