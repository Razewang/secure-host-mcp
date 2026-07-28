import { access } from "node:fs/promises";
import * as pty from "node-pty";

async function shell() {
  if (process.platform !== "win32") return { file: "/bin/bash", args: ["-l"], input: "printf 'secure-host-pty-ok\\n'\nexit\n" };
  const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  try {
    await access(pwsh);
    return { file: pwsh, args: ["-NoLogo", "-NoProfile"], input: "Write-Output 'secure-host-pty-ok'; exit\r" };
  } catch {
    return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile"], input: "Write-Output 'secure-host-pty-ok'; exit\r" };
  }
}

const selected = await shell();
const terminal = pty.spawn(selected.file, selected.args, {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
  ...(process.platform === "win32" ? { useConpty: true, useConptyDll: true } : {})
});
let output = "";
const completed = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`PTY smoke test timed out: ${output}`)), 10000);
  let markerSeen = false;
  terminal.onData((data) => {
    output += data;
    markerSeen ||= output.includes("secure-host-pty-ok");
  });
  terminal.onExit(() => {
    if (markerSeen) {
      clearTimeout(timer);
      resolve();
    } else {
      clearTimeout(timer);
      reject(new Error(`PTY exited before marker output: ${output}`));
    }
  });
});
terminal.write(selected.input);
await completed;
terminal.kill();
console.log("PTY smoke test passed");
process.exit(0);
