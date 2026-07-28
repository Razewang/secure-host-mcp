import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const result = await build({
  entryPoints: ["mcp-app/runtime-status.js"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true
});
const script = result.outputFiles[0]?.text;
if (!script) throw new Error("MCP App bundle was not generated");
const [template, style] = await Promise.all([
  readFile("mcp-app/runtime-status.template.html", "utf8"),
  readFile("mcp-app/runtime-status.css", "utf8")
]);
const html = template
  .replace("__SECURE_HOST_MCP_APP_STYLE__", style)
  .replace("__SECURE_HOST_MCP_APP_SCRIPT__", script.replaceAll("</script", "<\\/script"));
await mkdir("web", { recursive: true });
await writeFile(path.join("web", "runtime-status.html"), html);
