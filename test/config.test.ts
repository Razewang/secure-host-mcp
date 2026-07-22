import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, tokenMatches } from "../src/config.js";

const dirs: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("ConfigStore", () => {
  it("creates a one-time owner token and stores only its hash", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const store = new ConfigStore(dir);
    const token = await store.ensureOwnerToken(); expect(token).toBeTruthy(); expect(await store.ensureOwnerToken()).toBeUndefined();
    const secrets = await store.loadSecrets(); expect(secrets.tokens).toHaveLength(1); expect(secrets.tokens[0] && tokenMatches(token!, secrets.tokens[0])).toBe(true);
    expect(await readFile(store.secretsPath, "utf8")).not.toContain(token!);
    if (process.platform !== "win32") expect((await stat(store.secretsPath)).mode & 0o777).toBe(0o600);
  });
});
