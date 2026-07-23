import type { AppConfig, ConfigStore } from "./config.js";

export function setupSummary(config: AppConfig): string[] {
  const messages = [
    `MCP bind: http://${config.mcp.host}:${config.mcp.port}/mcp`,
    `Administration bind: http://${config.admin.host}:${config.admin.port}/`,
  ];
  if (config.mcp.host === "0.0.0.0" || config.admin.host === "0.0.0.0") {
    messages.push("NETWORK: wildcard listeners accept remote connections when the host firewall, router, and cloud security rules allow them.");
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
