import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { prepareInteractiveLaunch, setupSummary } from "../src/launch.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("interactive launch preparation", () => {
  it("persists defaults and creates the owner token only once", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-launch-")); dirs.push(dir); const store = new ConfigStore(dir);
    const first = await prepareInteractiveLaunch(store); const second = await prepareInteractiveLaunch(store);
    expect(first.ownerToken).toBeTypeOf("string"); expect(second.ownerToken).toBeUndefined();
    expect(JSON.parse(await readFile(store.configPath, "utf8"))).toMatchObject({ version: 1, dataDir: dir, mcp: { host: "0.0.0.0" }, admin: { host: "0.0.0.0" } });
    expect(setupSummary(first.config).join("\n")).toContain("wildcard listeners accept remote connections");
    expect(setupSummary(first.config).join("\n")).toContain("authentication does not encrypt bearer tokens");
    expect(setupSummary(first.config).join("\n")).toContain("ChatGPT requires a public HTTPS MCP URL");
    const secrets = JSON.parse(await readFile(store.secretsPath, "utf8")) as { tokens: unknown[] };
    expect(secrets.tokens).toHaveLength(1);
  });
});
