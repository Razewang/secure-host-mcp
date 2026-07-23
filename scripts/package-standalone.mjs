import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const platform = process.platform;
const arch = process.arch;
const name = `secure-host-mcp-${platform}-${arch}`;
const target = path.resolve("release", name);
const metadata = JSON.parse(await readFile("package.json", "utf8"));
if (typeof metadata.version !== "string" || !metadata.version) throw new Error("package.json must contain a version");
await rm(target, { recursive: true, force: true });
await mkdir(path.join(target, "runtime"), { recursive: true });

await build({
  entryPoints: ["src/cli.ts"],
  outfile: path.join(target, "app.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }
});

const runtimeName = platform === "win32" ? "node.exe" : "node";
await copyFile(process.execPath, path.join(target, "runtime", runtimeName));
if (platform !== "win32") {
  const { chmod } = await import("node:fs/promises");
  await chmod(path.join(target, "runtime", runtimeName), 0o755);
}
await cp("examples", path.join(target, "examples"), { recursive: true });
await cp("web", path.join(target, "web"), { recursive: true });
await copyFile("README.md", path.join(target, "README.md"));
await copyFile("README.zh-CN.md", path.join(target, "README.zh-CN.md"));
await copyFile("LICENSE", path.join(target, "LICENSE"));
await copyFile("config.example.json", path.join(target, "config.example.json"));
await copyFile("tokens.example.json", path.join(target, "tokens.example.json"));
await writeFile(path.join(target, "package.json"), `${JSON.stringify({ name: metadata.name, version: metadata.version, license: metadata.license }, null, 2)}\n`);

if (platform === "win32") {
  await writeFile(path.join(target, "secure-host-mcp.cmd"), "@echo off\r\n\"%~dp0runtime\\node.exe\" \"%~dp0app.mjs\" %*\r\n");
  const launcher = process.env.SECURE_HOST_MCP_WINDOWS_LAUNCHER;
  if (launcher) await copyFile(path.resolve(launcher), path.join(target, "secure-host-mcp.exe"));
} else {
  const launcher = path.join(target, "secure-host-mcp");
  await writeFile(launcher, "#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nexec \"$SCRIPT_DIR/runtime/node\" \"$SCRIPT_DIR/app.mjs\" \"$@\"\n", { mode: 0o755 });
}

const forbiddenNames = new Set([".agents", ".codex", ".trellis", "AGENTS.md", ".env"]);
async function assertPublicContents(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (forbiddenNames.has(entry.name) || entry.name.endsWith(".log")) throw new Error(`Forbidden release content: ${entry.name}`);
    if (entry.isDirectory()) await assertPublicContents(path.join(directory, entry.name));
  }
}
await assertPublicContents(target);
console.log(`Created ${target}`);
