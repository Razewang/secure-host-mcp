import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { resolveShell } from "../src/shell.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveShell", () => {
  it("keeps configured interactive shells argument-free and configures batch mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-shell-"));
    dirs.push(dir);
    const config = await new ConfigStore(dir).loadConfig();
    config.execution.shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    expect(await resolveShell(config, "interactive")).toEqual({ file: config.execution.shell, args: [] });
    expect((await resolveShell(config, "batch")).args).toEqual(
      process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command"] : ["-lc"]
    );
  });
});
