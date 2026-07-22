import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { packageVersion } from "../src/version.js";

describe("package version", () => {
  it("uses package.json as the canonical source", () => {
    const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(packageVersion()).toBe(metadata.version);
  });
});
