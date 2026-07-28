import { access } from "node:fs/promises";
import type { AppConfig } from "./config.js";

export type ShellMode = "batch" | "interactive";

export interface ResolvedShell {
  file: string;
  args: string[];
}

export async function resolveShell(config: AppConfig, mode: ShellMode): Promise<ResolvedShell> {
  if (config.execution.shell) {
    return {
      file: config.execution.shell,
      args: mode === "batch"
        ? process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command"] : ["-lc"]
        : []
    };
  }
  if (process.platform !== "win32") {
    return { file: "/bin/bash", args: [mode === "batch" ? "-lc" : "-l"] };
  }

  const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const file = await access(pwsh).then(() => pwsh, () => "powershell.exe");
  if (mode === "batch") return { file, args: ["-NoProfile", "-NonInteractive", "-Command"] };
  return {
    file,
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "Remove-Module PSReadLine -ErrorAction SilentlyContinue"]
  };
}
