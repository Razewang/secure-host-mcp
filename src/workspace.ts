import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { AppError } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_EXCLUDED_NAMES = new Set([".git", ".hg", ".svn", "node_modules", "dist", "coverage", ".next"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface WorkspaceChange {
  type: "create" | "replace" | "delete";
  path: string;
  content?: string;
  oldText?: string;
  newText?: string;
  expectedSha256?: string;
}

interface PreparedChange {
  type: WorkspaceChange["type"];
  displayPath: string;
  target: string;
  content?: string;
  baselineSha256?: string;
  mode?: number;
}

interface InstalledChange {
  target: string;
  backup?: string;
  created: boolean;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function normalizeDisplay(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  return relative ? relative.split(path.sep).join("/") : ".";
}

function decodeUtf8(data: Buffer, displayPath: string): string {
  if (data.subarray(0, 4096).includes(0)) throw new AppError("BINARY_FILE", `binary file is not supported: ${displayPath}`);
  try {
    return UTF8_DECODER.decode(data);
  } catch {
    throw new AppError("UNSUPPORTED_ENCODING", `file is not valid UTF-8: ${displayPath}`);
  }
}

function globRegex(glob: string): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function boundedText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(value);
  if (encoded.length <= maxBytes) return { text: value, truncated: false };
  return { text: encoded.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

function fitUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

export class CodingWorkspace {
  readonly root: string;
  private rootReal?: string;

  constructor(private readonly config: AppConfig) {
    this.root = path.resolve(config.coding.root ?? path.join(config.dataDir, "workspace"));
  }

  async initialize(): Promise<void> {
    const parsed = path.parse(this.root);
    if (samePath(this.root, parsed.root) || samePath(this.root, os.homedir())) {
      throw new AppError("UNSAFE_WORKSPACE", "coding workspace cannot be a filesystem root or the user home directory", 500);
    }
    await mkdir(this.root, { recursive: true });
    this.rootReal = await realpath(this.root);
  }

  info(): Record<string, unknown> {
    return {
      enabled: this.config.coding.enabled,
      root: this.root,
      maxReadBytes: this.config.coding.maxReadBytes,
      maxSearchResults: this.config.coding.maxSearchResults,
      maxPatchBytes: this.config.coding.maxPatchBytes
    };
  }

  private requireRoot(): string {
    if (!this.rootReal) throw new AppError("WORKSPACE_NOT_READY", "coding workspace is not initialized", 500);
    return this.rootReal;
  }

  private pathParts(rawPath: string): string[] {
    if (!rawPath || rawPath === ".") return [];
    if (rawPath.includes("\0")) throw new AppError("INVALID_PATH", "path contains a NUL byte");
    if (path.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath)) {
      throw new AppError("ABSOLUTE_PATH_DENIED", "use a path relative to the coding workspace");
    }
    const parts = rawPath.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".");
    if (parts.some((part) => part === "..")) throw new AppError("PATH_OUTSIDE_WORKSPACE", "path traversal is not allowed");
    return parts;
  }

  private async resolveExisting(rawPath: string): Promise<{ path: string; display: string }> {
    const root = this.requireRoot();
    const candidate = path.join(root, ...this.pathParts(rawPath));
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError("NOT_FOUND", `path not found: ${rawPath}`, 404);
      throw error;
    }
    if (!isInside(root, resolved)) throw new AppError("SYMLINK_ESCAPE", "path resolves outside the coding workspace");
    return { path: resolved, display: normalizeDisplay(root, resolved) };
  }

  private async resolveForWrite(rawPath: string): Promise<{ path: string; display: string }> {
    const root = this.requireRoot();
    const parts = this.pathParts(rawPath);
    if (!parts.length) throw new AppError("INVALID_PATH", "a file path is required");
    const candidate = path.join(root, ...parts);
    let existingParent = path.dirname(candidate);
    while (existingParent !== root) {
      try {
        const info = await stat(existingParent);
        if (info.isDirectory()) break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      existingParent = path.dirname(existingParent);
    }
    const resolvedParent = await realpath(existingParent);
    if (!isInside(root, resolvedParent)) throw new AppError("SYMLINK_ESCAPE", "write parent resolves outside the coding workspace");
    try {
      const resolvedTarget = await realpath(candidate);
      if (!isInside(root, resolvedTarget) || !samePath(resolvedTarget, candidate)) {
        throw new AppError("SYMLINK_ESCAPE", "writing through a symbolic link is not allowed");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { path: candidate, display: normalizeDisplay(root, candidate) };
  }

  async readFile(input: { path: string; startLine?: number; maxLines?: number; maxBytes?: number }): Promise<Record<string, unknown>> {
    const resolved = await this.resolveExisting(input.path);
    const info = await stat(resolved.path);
    if (!info.isFile()) throw new AppError("NOT_A_FILE", `path is not a file: ${input.path}`);
    const maximum = Math.min(input.maxBytes ?? this.config.coding.maxReadBytes, this.config.coding.maxReadBytes);
    const startLine = Math.max(1, input.startLine ?? 1);
    const maxLines = Math.max(1, Math.min(input.maxLines ?? 1000, 5000));
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const output: string[] = [];
    let outputBytes = 0;
    let line = 1;
    let lastCapturedLine = startLine - 1;
    let sawData = false;
    let byteTruncated = false;
    let byteTruncatedAtLine: number | undefined;
    const append = (value: string): void => {
      if (!value || byteTruncated) return;
      const remaining = maximum - outputBytes;
      if (remaining <= 0) {
        byteTruncated = true;
        return;
      }
      const fitted = fitUtf8(value, remaining);
      output.push(fitted);
      outputBytes += Buffer.byteLength(fitted);
      if (fitted.length < value.length) byteTruncated = true;
    };
    const consume = (value: string): void => {
      if (!value) return;
      sawData = true;
      let offset = 0;
      while (offset < value.length) {
        const newline = value.indexOf("\n", offset);
        const end = newline < 0 ? value.length : newline;
        const selected = line >= startLine && line < startLine + maxLines;
        if (selected) {
          const alreadyTruncated = byteTruncated;
          append(value.slice(offset, end));
          if (newline >= 0) append("\n");
          if (!alreadyTruncated) lastCapturedLine = line;
          if (!alreadyTruncated && byteTruncated) byteTruncatedAtLine = line;
        }
        if (newline < 0) break;
        line += 1;
        offset = newline + 1;
      }
    };
    try {
      for await (const rawChunk of createReadStream(resolved.path)) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        if (chunk.includes(0)) throw new AppError("BINARY_FILE", `binary file is not supported: ${resolved.display}`);
        hash.update(chunk);
        consume(decoder.decode(chunk, { stream: true }));
      }
      consume(decoder.decode());
    } catch (error) {
      if (error instanceof TypeError) throw new AppError("UNSUPPORTED_ENCODING", `file is not valid UTF-8: ${resolved.display}`);
      throw error;
    }
    const totalLines = sawData ? line : 0;
    const lineTruncated = startLine + maxLines - 1 < totalLines;
    const truncated = byteTruncated || lineTruncated;
    return {
      path: resolved.display,
      content: output.join(""),
      sha256: hash.digest("hex"),
      size: info.size,
      startLine,
      endLine: lastCapturedLine,
      totalLines,
      truncated,
      ...(truncated ? { nextStartLine: byteTruncated ? (byteTruncatedAtLine ?? startLine) : lastCapturedLine + 1 } : {})
    };
  }

  async listDirectory(input: { path?: string; recursive?: boolean; maxDepth?: number; maxEntries?: number; includeHidden?: boolean }): Promise<Record<string, unknown>> {
    const resolved = await this.resolveExisting(input.path ?? ".");
    if (!(await stat(resolved.path)).isDirectory()) throw new AppError("NOT_A_DIRECTORY", `path is not a directory: ${input.path ?? "."}`);
    const recursive = input.recursive ?? false;
    const maxDepth = Math.max(1, Math.min(input.maxDepth ?? 3, 20));
    const maxEntries = Math.max(1, Math.min(input.maxEntries ?? 1000, 5000));
    const entries: Array<Record<string, unknown>> = [];
    const queue = [{ directory: resolved.path, depth: 0 }];
    let truncated = false;
    while (queue.length && !truncated) {
      const current = queue.shift()!;
      const directory = await opendir(current.directory);
      for await (const entry of directory) {
        if (!input.includeHidden && entry.name.startsWith(".")) continue;
        if (DEFAULT_EXCLUDED_NAMES.has(entry.name)) continue;
        const candidate = path.join(current.directory, entry.name);
        const display = normalizeDisplay(this.requireRoot(), candidate);
        const info = await lstat(candidate);
        entries.push({
          path: display,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
          size: info.size,
          modifiedAt: info.mtime.toISOString()
        });
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        if (recursive && entry.isDirectory() && current.depth + 1 < maxDepth) {
          queue.push({ directory: candidate, depth: current.depth + 1 });
        }
      }
    }
    entries.sort((left, right) => String(left.path).localeCompare(String(right.path)));
    return { path: resolved.display, entries, truncated };
  }

  async listFiles(input: { path?: string; glob?: string; maxResults?: number; includeHidden?: boolean }): Promise<Record<string, unknown>> {
    const result = await this.listDirectory({
      path: input.path,
      recursive: true,
      maxDepth: 20,
      maxEntries: Math.min((input.maxResults ?? 1000) * 4, 5000),
      includeHidden: input.includeHidden
    });
    const matcher = input.glob ? globRegex(input.glob) : undefined;
    const maximum = Math.max(1, Math.min(input.maxResults ?? 1000, 5000));
    const matching = (result.entries as Array<Record<string, unknown>>)
      .filter((entry) => entry.type === "file" && (!matcher || matcher.test(String(entry.path))));
    const files = matching.slice(0, maximum);
    return { path: result.path, files, truncated: Boolean(result.truncated) || matching.length > maximum };
  }

  async searchText(input: {
    query: string;
    path?: string;
    regex?: boolean;
    caseSensitive?: boolean;
    glob?: string;
    maxResults?: number;
  }): Promise<Record<string, unknown>> {
    if (!input.query) throw new AppError("INVALID_QUERY", "query must not be empty");
    const flags = input.caseSensitive ? "" : "i";
    let expression: RegExp;
    try {
      expression = input.regex ? new RegExp(input.query, flags) : new RegExp(input.query.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"), flags);
    } catch (error) {
      throw new AppError("INVALID_REGEX", error instanceof Error ? error.message : "invalid regular expression");
    }
    const maximum = Math.max(1, Math.min(input.maxResults ?? this.config.coding.maxSearchResults, this.config.coding.maxSearchResults));
    const searchRoot = await this.resolveExisting(input.path ?? ".");
    const searchInfo = await stat(searchRoot.path);
    const listed = searchInfo.isFile()
      ? { files: [{ path: searchRoot.display }] }
      : await this.listFiles({ path: input.path, glob: input.glob, maxResults: 5000 });
    const matches: Array<Record<string, unknown>> = [];
    let scannedFiles = 0;
    for (const file of listed.files as Array<Record<string, unknown>>) {
      if (matches.length >= maximum) break;
      const display = String(file.path);
      const resolved = await this.resolveExisting(display);
      const info = await stat(resolved.path);
      if (info.size > this.config.coding.maxReadBytes * 4) continue;
      let text: string;
      try {
        text = decodeUtf8(await readFile(resolved.path), display);
      } catch (error) {
        if (error instanceof AppError && ["BINARY_FILE", "UNSUPPORTED_ENCODING"].includes(error.code)) continue;
        throw error;
      }
      scannedFiles += 1;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < maximum; index += 1) {
        const found = expression.exec(lines[index]!);
        expression.lastIndex = 0;
        if (!found) continue;
        matches.push({
          path: display,
          line: index + 1,
          column: (found.index ?? 0) + 1,
          preview: boundedText(lines[index]!, 1000).text
        });
      }
    }
    return { query: input.query, matches, scannedFiles, truncated: matches.length >= maximum };
  }

  private async prepareChange(change: WorkspaceChange): Promise<PreparedChange> {
    const resolved = await this.resolveForWrite(change.path);
    let existing: Buffer | undefined;
    let existingMode: number | undefined;
    try {
      const info = await stat(resolved.path);
      if (!info.isFile()) throw new AppError("NOT_A_FILE", `patch target is not a file: ${change.path}`);
      existing = await readFile(resolved.path);
      existingMode = info.mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const baselineSha256 = existing ? sha256(existing) : undefined;
    if (change.expectedSha256 && change.expectedSha256 !== baselineSha256) {
      throw new AppError("STALE_FILE", `file changed since it was read: ${change.path}`, 409);
    }
    if (change.type === "create") {
      if (existing) throw new AppError("FILE_EXISTS", `cannot create an existing file: ${change.path}`, 409);
      if (change.content === undefined) throw new AppError("INVALID_CHANGE", "create requires content");
      return { type: change.type, displayPath: resolved.display, target: resolved.path, content: change.content };
    }
    if (!existing) throw new AppError("NOT_FOUND", `patch target not found: ${change.path}`, 404);
    if (change.type === "delete") {
      return { type: change.type, displayPath: resolved.display, target: resolved.path, baselineSha256, mode: existingMode };
    }
    if (!change.oldText) throw new AppError("INVALID_CHANGE", "replace requires a non-empty oldText");
    if (change.newText === undefined) throw new AppError("INVALID_CHANGE", "replace requires newText");
    const current = decodeUtf8(existing, resolved.display);
    const first = current.indexOf(change.oldText);
    if (first < 0) throw new AppError("PATCH_CONTEXT_NOT_FOUND", `oldText was not found in ${change.path}`, 409);
    if (current.indexOf(change.oldText, first + change.oldText.length) >= 0) {
      throw new AppError("PATCH_CONTEXT_AMBIGUOUS", `oldText occurs more than once in ${change.path}`, 409);
    }
    const content = `${current.slice(0, first)}${change.newText}${current.slice(first + change.oldText.length)}`;
    return { type: change.type, displayPath: resolved.display, target: resolved.path, content, baselineSha256, mode: existingMode };
  }

  async applyPatch(input: { changes: WorkspaceChange[]; dryRun?: boolean }): Promise<Record<string, unknown>> {
    if (!input.changes.length) throw new AppError("INVALID_CHANGE", "at least one change is required");
    const serializedBytes = Buffer.byteLength(JSON.stringify(input.changes));
    if (serializedBytes > this.config.coding.maxPatchBytes) throw new AppError("PATCH_TOO_LARGE", "patch exceeds the configured byte limit");
    const paths = new Set<string>();
    const prepared: PreparedChange[] = [];
    for (const change of input.changes) {
      const item = await this.prepareChange(change);
      if (paths.has(item.target)) throw new AppError("DUPLICATE_PATH", `patch contains duplicate path: ${change.path}`);
      paths.add(item.target);
      prepared.push(item);
    }
    if (input.dryRun) {
      return { dryRun: true, changed: prepared.map((change) => ({ type: change.type, path: change.displayPath })) };
    }
    const installed: InstalledChange[] = [];
    const temporary = new Set<string>();
    try {
      for (const change of prepared) {
        await mkdir(path.dirname(change.target), { recursive: true });
        const currentSha256 = await readFile(change.target).then(sha256).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (currentSha256 !== change.baselineSha256) throw new AppError("STALE_FILE", `file changed while applying patch: ${change.displayPath}`, 409);
        let temp: string | undefined;
        if (change.content !== undefined) {
          temp = path.join(path.dirname(change.target), `.secure-host-mcp-${randomUUID()}.tmp`);
          temporary.add(temp);
          await writeFile(temp, change.content, { encoding: "utf8", mode: change.mode ?? 0o644 });
          if (change.mode !== undefined && process.platform !== "win32") await chmod(temp, change.mode);
        }
        let backup: string | undefined;
        if (change.baselineSha256) {
          backup = path.join(path.dirname(change.target), `.secure-host-mcp-${randomUUID()}.bak`);
          await rename(change.target, backup);
        }
        const installedChange = { target: change.target, ...(backup ? { backup } : {}), created: !change.baselineSha256 };
        if (backup) installed.push(installedChange);
        if (temp) {
          await rename(temp, change.target);
          temporary.delete(temp);
        }
        if (!backup) installed.push(installedChange);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const change of installed.reverse()) {
        await rm(change.target, { force: true }).catch(() => undefined);
        if (change.backup) {
          await rename(change.backup, change.target).catch((rollbackError: unknown) => {
            rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
          });
        }
      }
      await Promise.all([...temporary].map((file) => rm(file, { force: true }).catch(() => undefined)));
      if (rollbackErrors.length) throw new AppError("PATCH_ROLLBACK_FAILED", `patch failed and rollback was incomplete: ${rollbackErrors.join("; ")}`, 500);
      throw error;
    }
    await Promise.all(installed.flatMap((change) => change.backup ? [rm(change.backup, { force: true }).catch(() => undefined)] : []));
    return { dryRun: false, changed: prepared.map((change) => ({ type: change.type, path: change.displayPath })) };
  }

  private async runGit(args: string[], maxBytes = this.config.coding.maxReadBytes): Promise<{ output: string; truncated: boolean }> {
    try {
      const completed = await execFileAsync("git", ["-C", this.root, ...args], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: Math.max(maxBytes * 2, 1024 * 1024),
        windowsHide: true
      });
      const bounded = boundedText(completed.stdout, maxBytes);
      return { output: bounded.text, truncated: bounded.truncated };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (failure.code === "ENOENT") throw new AppError("GIT_NOT_INSTALLED", "git executable was not found", 500);
      throw new AppError("GIT_ERROR", failure.stderr?.trim() || failure.message, 400);
    }
  }

  private validateRevision(revision: string): string {
    if (!revision || revision.startsWith("-") || !/^[A-Za-z0-9_./@{}^~:+-]{1,200}$/.test(revision)) {
      throw new AppError("INVALID_REVISION", "invalid Git revision");
    }
    return revision;
  }

  async gitStatus(): Promise<Record<string, unknown>> {
    const result = await this.runGit(["status", "--porcelain=v1", "--branch"]);
    return { status: result.output, truncated: result.truncated };
  }

  async snapshot(): Promise<Record<string, unknown>> {
    try {
      const [head, status] = await Promise.all([
        this.runGit(["rev-parse", "HEAD"], 1024),
        this.runGit(["status", "--porcelain=v1", "--branch"], Math.min(this.config.coding.maxReadBytes, 64 * 1024))
      ]);
      const lines = status.output.split(/\r?\n/).filter(Boolean);
      const branchLine = lines[0]?.startsWith("## ") ? lines[0].slice(3) : "";
      return {
        enabled: true,
        root: this.root,
        git: {
          available: true,
          head: head.output.trim(),
          branch: branchLine.split("...")[0] || branchLine || undefined,
          dirty: lines.slice(branchLine ? 1 : 0).length > 0,
          status: status.output,
          truncated: status.truncated
        }
      };
    } catch (error) {
      if (error instanceof AppError && (error.code === "GIT_ERROR" || error.code === "GIT_NOT_INSTALLED")) {
        return { enabled: true, root: this.root, git: { available: false, error: error.message } };
      }
      throw error;
    }
  }

  async gitDiff(input: { staged?: boolean; path?: string; contextLines?: number; maxBytes?: number }): Promise<Record<string, unknown>> {
    const args = ["diff", "--no-ext-diff", `--unified=${Math.max(0, Math.min(input.contextLines ?? 3, 20))}`];
    if (input.staged) args.push("--cached");
    if (input.path) {
      const resolved = await this.resolveForWrite(input.path);
      args.push("--", resolved.display);
    }
    const result = await this.runGit(args, Math.min(input.maxBytes ?? this.config.coding.maxReadBytes, this.config.coding.maxReadBytes));
    return { diff: result.output, truncated: result.truncated, staged: input.staged ?? false };
  }

  async gitLog(input: { maxCount?: number; skip?: number; path?: string }): Promise<Record<string, unknown>> {
    const maxCount = Math.max(1, Math.min(input.maxCount ?? 20, 100));
    const skip = Math.max(0, input.skip ?? 0);
    const args = [
      "log",
      `--max-count=${maxCount}`,
      `--skip=${skip}`,
      "--date=iso-strict",
      "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e"
    ];
    if (input.path) {
      const resolved = await this.resolveForWrite(input.path);
      args.push("--", resolved.display);
    }
    const result = await this.runGit(args);
    const commits = result.output.split("\x1e").flatMap((record) => {
      const fields = record.trim().split("\x1f");
      return fields.length < 5 || !fields[0] ? [] : [{
        hash: fields[0],
        shortHash: fields[1],
        author: fields[2],
        date: fields[3],
        subject: fields[4]
      }];
    });
    return { commits, skip, maxCount, truncated: result.truncated };
  }

  async gitShow(input: { revision?: string; maxBytes?: number }): Promise<Record<string, unknown>> {
    const revision = this.validateRevision(input.revision ?? "HEAD");
    const result = await this.runGit(
      ["show", "--no-ext-diff", "--format=fuller", "--stat", "--patch", revision],
      Math.min(input.maxBytes ?? this.config.coding.maxReadBytes, this.config.coding.maxReadBytes)
    );
    return { revision, content: result.output, truncated: result.truncated };
  }

  async gitBlame(input: { path: string; startLine?: number; endLine?: number }): Promise<Record<string, unknown>> {
    const resolved = await this.resolveExisting(input.path);
    const startLine = Math.max(1, input.startLine ?? 1);
    const endLine = Math.max(startLine, Math.min(input.endLine ?? startLine + 199, startLine + 999));
    const result = await this.runGit(["blame", "--line-porcelain", "-L", `${startLine},${endLine}`, "--", resolved.display]);
    return { path: resolved.display, startLine, endLine, blame: result.output, truncated: result.truncated };
  }
}
