import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { packageVersion } from "../src/version.js";

describe("package version", () => {
  it("uses package.json as the canonical source", () => {
    const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(packageVersion()).toBe(metadata.version);
  });

  it("prefers a standalone bundle manifest over a parent project manifest", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "secure-host-mcp-version-"));
    try {
      const bundle = path.join(parent, "bundle");
      await writeFile(path.join(parent, "package.json"), JSON.stringify({ version: "9.9.9" }));
      await mkdir(bundle);
      await writeFile(path.join(bundle, "package.json"), JSON.stringify({ version: "1.2.3" }));
      expect(packageVersion(pathToFileURL(path.join(bundle, "app.mjs")))).toBe("1.2.3");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
