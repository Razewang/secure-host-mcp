import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const platform = process.platform;
const arch = process.arch;
const name = `secure-host-mcp-${platform}-${arch}`;
const target = path.resolve("release", name);
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
await copyFile("README.md", path.join(target, "README.md"));
await copyFile("LICENSE", path.join(target, "LICENSE"));
await copyFile("config.example.json", path.join(target, "config.example.json"));

if (platform === "win32") {
  await writeFile(path.join(target, "secure-host-mcp.cmd"), "@echo off\r\n\"%~dp0runtime\\node.exe\" \"%~dp0app.mjs\" %*\r\n");
} else {
  const launcher = path.join(target, "secure-host-mcp");
  await writeFile(launcher, "#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nexec \"$SCRIPT_DIR/runtime/node\" \"$SCRIPT_DIR/app.mjs\" \"$@\"\n", { mode: 0o755 });
}
console.log(`Created ${target}`);
