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

function httpUrl(host: string, port: number, pathname = "/"): string {
  const formattedHost = host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host;
  return `http://${formattedHost}:${port}${pathname}`;
}

function mcpUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/mcp") ? normalized : `${normalized}/mcp`;
}

export function enableLanHttp(config: AppConfig): void {
  config.admin.allowLanHttp = true;
  if (isLoopbackHost(config.admin.host)) config.admin.host = "0.0.0.0";
}

export function setupSummary(config: AppConfig): string[] {
  const messages = [
    `MCP bind: ${httpUrl(config.mcp.host, config.mcp.port, "/mcp")}`,
    `Administration bind: ${httpUrl(config.admin.host, config.admin.port)}`,
  ];
  if (config.network.publicAddress) {
    messages.push(`Public MCP URL: ${httpUrl(config.network.publicAddress, config.mcp.port, "/mcp")}`);
    messages.push(`Web console URL: ${httpUrl(config.network.publicAddress, config.admin.port)}`);
  } else if (config.network.hasPublicIp === false) {
    messages.push("Public MCP URL: unavailable until a public IP, reverse proxy, or tunnel is configured.");
    messages.push("Web console URL: unavailable for direct Internet access; configure a public address or tunnel first.");
  }
  if (config.publicBaseUrl) messages.push(`Configured MCP URL: ${mcpUrl(config.publicBaseUrl)}`);
  if (!isLoopbackHost(config.mcp.host) || !isLoopbackHost(config.admin.host)) {
    messages.push("NETWORK: non-loopback listeners accept remote connections when the host firewall, router, and cloud security rules allow them.");
    messages.push("WARNING: HTTP is plaintext. Authentication does not encrypt the administrator token, connection tokens, OAuth codes, commands, or administration traffic. Use HTTPS or a trusted private network whenever possible.");
  }
  if (!config.publicBaseUrl?.startsWith("https://")) {
    messages.push("ChatGPT requires a public HTTPS MCP URL. Configure --public-url with an HTTPS reverse proxy, Cloudflare Tunnel, or frp endpoint.");
  }
  return messages;
}

export async function detectPublicIp(fetcher: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const response = await fetcher("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return undefined;
    const address = (await response.text()).match(/^ip=(.+)$/m)?.[1]?.trim();
    return address && isIP(address) ? address : undefined;
  } catch {
    return undefined;
  }
}

export async function prepareInteractiveLaunch(store: ConfigStore, options: { adminToken?: string; hasPublicIp?: boolean; publicAddress?: string } = {}): Promise<{ config: AppConfig; ownerToken?: string }> {
  const config = await store.loadConfig();
  if (options.hasPublicIp !== undefined) config.network.hasPublicIp = options.hasPublicIp;
  if (options.publicAddress) config.network.publicAddress = options.publicAddress;
  else if (options.hasPublicIp === false) delete config.network.publicAddress;
  await store.saveConfig(config);
  const ownerToken = await store.ensureConfiguredAdminToken(options.adminToken);
  return { config, ...(ownerToken ? { ownerToken } : {}) };
}
