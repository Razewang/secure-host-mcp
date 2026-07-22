import type { AppConfig, ConfigStore } from "./config.js";

export async function prepareInteractiveLaunch(store: ConfigStore): Promise<{ config: AppConfig; ownerToken?: string }> {
  const config = await store.loadConfig();
  await store.saveConfig(config);
  const ownerToken = await store.ensureOwnerToken();
  return { config, ...(ownerToken ? { ownerToken } : {}) };
}
