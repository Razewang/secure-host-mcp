import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const atomicWriteQueues = new Map<string, Promise<void>>();
const WINDOWS_RENAME_RETRIES = 5;

async function renameAtomically(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = process.platform === "win32" && ["EACCES", "EBUSY", "EPERM"].includes(code ?? "");
      if (!retryable || attempt >= WINDOWS_RENAME_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export async function atomicWriteJson(file: string, value: unknown, restricted = false): Promise<void> {
  const target = path.resolve(file);
  const previous = atomicWriteQueues.get(target) ?? Promise.resolve();
  const operation = previous.then(async () => {
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: restricted ? 0o600 : 0o644
      });
      await renameAtomically(temp, target);
      if (restricted && process.platform !== "win32") await chmod(target, 0o600);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  const tail = operation.then(() => undefined, () => undefined);
  atomicWriteQueues.set(target, tail);
  try {
    await operation;
  } finally {
    if (atomicWriteQueues.get(target) === tail) atomicWriteQueues.delete(target);
  }
}
