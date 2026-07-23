import { readFileSync } from "node:fs";

interface PackageMetadata { version?: unknown }

export function packageVersion(moduleUrl: string | URL = import.meta.url): string {
  const candidates = [new URL("./package.json", moduleUrl), new URL("../package.json", moduleUrl)];
  for (const candidate of candidates) {
    try {
      const metadata = JSON.parse(readFileSync(candidate, "utf8")) as PackageMetadata;
      if (typeof metadata.version === "string" && metadata.version.length > 0) return metadata.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Unable to locate package.json for Secure Host MCP version information");
}
