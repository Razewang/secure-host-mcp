import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { CodingWorkspace } from "../src/workspace.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; workspace: CodingWorkspace }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-workspace-"));
  dirs.push(dataDir);
  const root = path.join(dataDir, "project");
  const store = new ConfigStore(dataDir);
  const config = await store.loadConfig();
  config.coding.root = root;
  const workspace = new CodingWorkspace(config);
  await workspace.initialize();
  return { root, workspace };
}

describe("CodingWorkspace", () => {
  it("rejects filesystem-root and user-home workspaces", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-workspace-"));
    dirs.push(dataDir);
    const config = await new ConfigStore(dataDir).loadConfig();
    config.coding.root = path.parse(dataDir).root;
    await expect(new CodingWorkspace(config).initialize()).rejects.toThrow("cannot be a filesystem root");
    config.coding.root = os.homedir();
    await expect(new CodingWorkspace(config).initialize()).rejects.toThrow("cannot be a filesystem root or the user home");
  });

  it("reads, lists, and searches bounded UTF-8 workspace files", async () => {
    const { root, workspace } = await fixture();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "hello.ts"), "export const greeting = 'hello';\n", "utf8");
    await writeFile(path.join(root, "root.ts"), "export const rootValue = true;\n", "utf8");
    await writeFile(path.join(root, "src", "skip.bin"), Buffer.from([0, 1, 2]));

    await expect(workspace.readFile({ path: "../outside.txt" })).rejects.toThrow("path traversal");
    await expect(workspace.readFile({ path: path.join(root, "src", "hello.ts") })).rejects.toThrow("relative");

    const read = await workspace.readFile({ path: "src/hello.ts" });
    expect(read).toMatchObject({ path: "src/hello.ts", content: "export const greeting = 'hello';\n", truncated: false });
    expect(read.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await workspace.readFile({ path: "src/hello.ts", maxBytes: 10 })).toMatchObject({
      content: "export con",
      truncated: true,
      nextStartLine: 1
    });

    const listed = await workspace.listFiles({ path: ".", glob: "**/*.ts" });
    expect(listed.files).toEqual([
      expect.objectContaining({ path: "root.ts", type: "file" }),
      expect.objectContaining({ path: "src/hello.ts", type: "file" })
    ]);

    const searched = await workspace.searchText({ query: "GREETING", caseSensitive: false, glob: "**/*.ts" });
    expect(searched.matches).toEqual([expect.objectContaining({ path: "src/hello.ts", line: 1, column: 14 })]);
    expect(searched.scannedFiles).toBe(2);
    expect((await workspace.searchText({ query: "rootValue", path: "root.ts" })).matches).toEqual([
      expect.objectContaining({ path: "root.ts", line: 1 })
    ]);
    await writeFile(path.join(root, "src", "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await expect(workspace.readFile({ path: "src/invalid.txt" })).rejects.toThrow("not valid UTF-8");
  });

  it("stages structured changes before committing and rejects stale or ambiguous replacements", async () => {
    const { root, workspace } = await fixture();
    await writeFile(path.join(root, "app.ts"), "const value = 1;\n", "utf8");
    const read = await workspace.readFile({ path: "app.ts" });

    await expect(workspace.applyPatch({
      changes: [
        { type: "create", path: "created.ts", content: "created\n" },
        { type: "replace", path: "app.ts", oldText: "missing", newText: "never" }
      ]
    })).rejects.toThrow("oldText was not found");
    await expect(readFile(path.join(root, "created.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const applied = await workspace.applyPatch({
      changes: [{
        type: "replace",
        path: "app.ts",
        oldText: "value = 1",
        newText: "value = 2",
        expectedSha256: String(read.sha256)
      }]
    });
    expect(applied.changed).toEqual([{ type: "replace", path: "app.ts" }]);
    expect(await readFile(path.join(root, "app.ts"), "utf8")).toBe("const value = 2;\n");

    await expect(workspace.applyPatch({
      changes: [{ type: "replace", path: "app.ts", oldText: "value = 2", newText: "value = 3", expectedSha256: String(read.sha256) }]
    })).rejects.toThrow("file changed since it was read");

    await writeFile(path.join(root, "repeated.txt"), "same\nsame\n", "utf8");
    await expect(workspace.applyPatch({
      changes: [{ type: "replace", path: "repeated.txt", oldText: "same", newText: "different" }]
    })).rejects.toThrow("occurs more than once");
  });

  it("does not follow symbolic links outside the configured workspace", async () => {
    const { root, workspace } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-outside-"));
    dirs.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    try {
      await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(workspace.readFile({ path: "escape/secret.txt" })).rejects.toThrow("outside");
    await expect(workspace.applyPatch({ changes: [{ type: "create", path: "escape/new.txt", content: "no" }] })).rejects.toThrow("outside");
  });

  it("returns bounded Git status, diff, log, show, and blame output", async () => {
    const { root, workspace } = await fixture();
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Workspace Test"], { cwd: root });
    await writeFile(path.join(root, "tracked.txt"), "first\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
    await writeFile(path.join(root, "tracked.txt"), "second\n", "utf8");

    expect(String((await workspace.gitStatus()).status)).toContain("tracked.txt");
    expect(String((await workspace.gitDiff({})).diff)).toContain("-first");
    expect((await workspace.gitLog({})).commits).toEqual([expect.objectContaining({ subject: "initial" })]);
    expect(String((await workspace.gitShow({ revision: "HEAD" })).content)).toContain("initial");
    expect(String((await workspace.gitBlame({ path: "tracked.txt" })).blame)).toContain("tracked.txt");
    await expect(workspace.gitShow({ revision: "--help" })).rejects.toThrow("invalid Git revision");
  });
});
