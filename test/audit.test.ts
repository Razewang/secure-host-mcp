import { mkdtemp, readdir, readFile, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { ConfigStore } from "../src/config.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
describe("AuditLog", () => {
  it("stores redacted command output and prunes expired files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir); const config = await new ConfigStore(dir).loadConfig(); const audit = new AuditLog(config);
    await audit.write({ correlationId: "c1", action: "command.execute", principalId: "owner", success: true, command: "echo secret", stdout: "secret", stderr: "" });
    const auditDir = path.join(dir, "audit"); const [file] = await readdir(auditDir); expect(await readFile(path.join(auditDir, file!), "utf8")).toContain("echo secret");
    const old = new Date(Date.now() - 31 * 86400000); await utimes(path.join(auditDir, file!), old, old); await audit.prune(); expect(await readdir(auditDir)).toHaveLength(0);
  });
  it.each(["metadata", "redacted", "full"] as const)("honors %s content mode", async (mode) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-")); dirs.push(dir);
    const config = await new ConfigStore(dir).loadConfig();
    config.audit.contentMode = mode;
    const literal = "admin-secret-value";
    const audit = new AuditLog(config, () => [literal]);
    await audit.write({
      correlationId: "c2",
      action: "command.execute",
      principalId: "owner",
      success: true,
      command: `curl -H "Authorization: Bearer bearer-value" --data "password=quoted password" ${literal}`,
      stdout: `token=token-value api_key=key-value ${literal}`,
      stderr: ""
    });
    const [file] = await readdir(path.join(dir, "audit"));
    const content = await readFile(path.join(dir, "audit", file!), "utf8");
    if (mode === "full") {
      expect(content).toContain(literal);
      expect(content).toContain("bearer-value");
    } else {
      expect(content).not.toContain(literal);
      expect(content).not.toContain("bearer-value");
      expect(content).not.toContain("token-value");
      expect(content).not.toContain("key-value");
    }
    if (mode === "metadata") {
      expect(content).not.toContain("\"command\":");
      expect(content).toContain("commandBytes");
    }
  });
});
