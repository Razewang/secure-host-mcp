import { describe, expect, it } from "vitest";
import { TerminalQueryResponder } from "../src/terminal-queries.js";

describe("TerminalQueryResponder", () => {
  it("answers supported device and cursor queries", () => {
    const responder = new TerminalQueryResponder();
    expect(responder.push("before\u001b[c middle\u001b[6nafter")).toEqual([
      "\u001b[?1;0c",
      "\u001b[1;1R"
    ]);
  });

  it("recognizes queries split across PTY output chunks", () => {
    const responder = new TerminalQueryResponder();
    expect(responder.push("text\u001b[")).toEqual([]);
    expect(responder.push("c")).toEqual(["\u001b[?1;0c"]);
    expect(responder.push("\u001b")).toEqual([]);
    expect(responder.push("[6n")).toEqual(["\u001b[1;1R"]);
  });

  it("ignores unrelated ANSI sequences and plain escaped text", () => {
    const responder = new TerminalQueryResponder();
    expect(responder.push("\\u001b[c\u001b[31mred\u001b[0m")).toEqual([]);
  });
});
