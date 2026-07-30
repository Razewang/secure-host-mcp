# Secure Host MCP

<p align="center">
  <a href="https://github.com/Razewang/secure-host-mcp/actions/workflows/ci.yml"><img src="https://github.com/Razewang/secure-host-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Razewang/secure-host-mcp/releases/latest"><img src="https://img.shields.io/github/v/release/Razewang/secure-host-mcp?label=Release" alt="Latest release"></a>
  <a href="https://www.npmjs.com/package/secure-host-mcp"><img src="https://img.shields.io/npm/v/secure-host-mcp?logo=npm" alt="npm"></a>
  <img src="https://img.shields.io/badge/Windows-x64-0078D4?logo=windows" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-FCC624?logo=linux&logoColor=000000" alt="Linux x64">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-000000?logo=apple" alt="macOS Apple Silicon">
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 20+">
  <img src="https://img.shields.io/badge/MCP-Streamable%20HTTP-5A45FF" alt="MCP Streamable HTTP">
  <a href="https://github.com/Razewang/secure-host-mcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

Secure Host MCP exposes a Windows, Linux, or macOS host terminal and coding workspace to remote MCP clients through Streamable HTTP. It is intentionally powerful: the default administrator token can edit code, inspect Git, execute any command available to the service account, inspect or launch configured tunnels, and request privileged operations.

## Download a standalone release

Download the archive for your platform from [GitHub Releases](https://github.com/Razewang/secure-host-mcp/releases/latest):

- Windows x64: extract the ZIP and double-click `secure-host-mcp.exe`. On first launch the console wizard asks about public-IP and Cloudflare Tunnel access, configures the administrator token, displays the connection URLs, and starts both servers.
- Linux x64: extract the `tar.gz` archive and run `./secure-host-mcp launch` for the same first-run initialization and startup behavior.
- macOS Apple Silicon: extract the `tar.gz` archive and run `./secure-host-mcp launch`. The archive currently targets arm64 Macs only.

No separate Node.js installation is required for these archives. The Windows executable is not code-signed yet, so Microsoft Defender SmartScreen may display an unknown-publisher warning. Verify the download against `SHA256SUMS.txt` before running it.

```powershell
# Windows PowerShell
(Get-FileHash .\secure-host-mcp-0.1.0-windows-x64.zip -Algorithm SHA256).Hash
```

```bash
# Linux / macOS
sha256sum -c SHA256SUMS.txt --ignore-missing
```

## Install and first setup

Requires Node.js 20 or newer when installed through npm:

```powershell
npm install -g secure-host-mcp
secure-host-mcp setup --public-url https://mcp.example.com --workspace /srv/projects
secure-host-mcp doctor
secure-host-mcp start
```

> **First run: the required first command is `setup`, not `start`.**
>
> A fresh installation has no administrator token yet. `setup` creates it
> (written to `tokens.json`), records the base configuration, and prints your
> connection URLs. `start` only launches servers that are already configured —
> on a machine that has never run `setup` it exits immediately with
> `ADMIN_TOKEN_MISSING: Run setup before starting the server`.
>
> The first-run flow is therefore: **1.** `setup` (once per machine) →
> **2.** `doctor` (optional health check) → **3.** `start` (every launch
> afterwards). If you prefer a single command, `secure-host-mcp launch` runs
> the first-time setup automatically when needed and then starts the servers —
> the same behavior as double-clicking `secure-host-mcp.exe` from the
> standalone package.

### Process lifecycle

`start` remains a foreground command. Add `--daemon` to detach it, redirect
stdout/stderr to the application log, and return after the child reports ready:

```powershell
# Foreground; stop with Ctrl+C
secure-host-mcp start

# Background
secure-host-mcp start --daemon

# Inspect, stop, or restart the managed process
secure-host-mcp status
secure-host-mcp status --json
secure-host-mcp stop
secure-host-mcp restart

# Use only when graceful shutdown times out
secure-host-mcp stop --force
secure-host-mcp restart --force
```

`secure-host-mcp launch --daemon` performs first-time setup when required and
then starts in the background. The PID record is stored as
`service-state.json` and background output as `service.log` under
`SECURE_HOST_MCP_HOME` (by default `~/.secure-host-mcp`). The status command
automatically removes a stale PID record after an unclean exit. Only processes
started by the same application data directory are managed; these commands do
not install an operating-system service or control unrelated Node processes.

When run in an interactive terminal for a new installation, `setup`:

1. Asks whether the device has a directly reachable public IP and detects it through Cloudflare's trace endpoint when possible.
2. Inspects `cloudflared` and offers to install the checksum-verified official binary when it is missing. Installing the binary does not create a Cloudflare account or tunnel configuration.
3. Lets you automatically generate the initial token or enter any non-empty token of your choice. There is no fixed token format; letters, numbers, and combinations are accepted.
4. Explains that the same initial token is both the web-console administrator token and a full-access MCP Bearer token.
5. Asks for the directory that remote coding tools may access. The default is a dedicated `workspace` directory under the application data directory.
6. Prints concrete public-IP MCP and web-console URLs when a public IP is available, plus a plaintext HTTP warning.

Non-interactive setup keeps automation compatibility: it generates the token without prompting and does not install Cloudflare automatically. New installations listen on all network interfaces by default so remote clients can connect when the host firewall, router, and cloud security rules permit it.

Endpoints default to:

- MCP and OAuth: `http://0.0.0.0:8767/mcp`
- Administration: `http://0.0.0.0:8768/`

`0.0.0.0` is a bind address, not a client URL. Connect with the server's IP address or DNS name. Both services start even when HTTPS is not configured, but authentication does not encrypt bearer tokens, OAuth codes, or administration traffic. ChatGPT requires a remotely reachable HTTPS MCP URL. Put Caddy, Nginx, Cloudflare Tunnel, frp, or another trusted reverse proxy in front of port 8767, and protect remote administration on port 8768 with HTTPS or a trusted private network. A minimal Caddy example is under `examples/`.

The administration URL serves a responsive bilingual dashboard after the administrator token is entered. It shows host resources and runtime configuration, creates and revokes scoped connection tokens, and controls configured frpc/cloudflared processes. Dashboard-created connection tokens are written to the same `tokens.json` registry used by setup and manual configuration.

For example, when setup detects `203.0.113.10`, it prints:

```text
Public MCP URL: http://203.0.113.10:8767/mcp
Web console URL: http://203.0.113.10:8768/
WARNING: HTTP is plaintext...
```

## ChatGPT OAuth connection

Use `https://mcp.example.com/mcp` as the server URL and choose OAuth. The server publishes its authorization and protected-resource metadata. A new client dynamically registers, ChatGPT opens the authorization page, and the host administrator enters the administrator token and approves the requested scopes. The server uses authorization code + PKCE and issues rotating refresh tokens with offline access.

Full write-capable MCP support in ChatGPT depends on the account/workspace plan and current Developer Mode availability.

## Terminal and jobs

The main one-shot and background MCP tools are `execute_command`, `start_job`, `job_status`, `read_job_output`, `write_job_input`, and `cancel_job`. For a real persistent PTY, use `create_terminal`, `read_terminal`, `write_terminal`, `resize_terminal`, `interrupt_terminal`, and `close_terminal`. Windows uses ConPTY with PowerShell 7 when available and Windows PowerShell otherwise; Linux and macOS use `/bin/bash` unless configured differently.

PTY output is kept in a bounded ring buffer with monotonic byte offsets. If a requested offset has expired, `read_terminal` returns the current `startOffset` and `droppedBytes` so clients never mistake truncated output for a complete transcript. Terminals remain alive across MCP disconnects until they exit, are closed, or reach their idle TTL. A Secure Host process restart terminates managed processes and restores only redacted summaries marked `interrupted`; it does not claim that operating-system processes survived.

Jobs and terminals belong to the authenticated token or OAuth principal that created them. A normal `command.run` principal can access only its own records; an `admin.manage` principal can inspect and stop all records. Unauthorized lookup returns the same not-found error as an unknown identifier.

`runtime_snapshot` is a read-only `system.read` tool. It always returns host status, includes visible Job/PTY records when the caller also has `command.run`, and includes workspace/Git state when the caller also has `workspace.read`. Clients that support MCP Apps can render the versioned `ui://secure-host/runtime-status-v1.html` resource as a read-only status card. Other clients receive the same text and `structuredContent`; the card has no command, termination, approval, or polling controls.

Commands are not sandboxed or allowlisted. Run the service under a dedicated account unless full user/root access is intentional. `execute_elevated` fails closed until the process is already elevated or a privileged helper is installed. `set_admin_mode` records the request; service reconfiguration must be applied by an installed service adapter or the local CLI.

## Remote coding workspace

When `coding.enabled` is true, the MCP catalog also includes:

- `workspace_info`, `read_file`, `list_directory`, `list_files`, and `search_text`
- `apply_patch`
- `git_status`, `git_diff`, `git_log`, `git_show`, and `git_blame`

These tools are implemented independently in TypeScript. They do not embed Codex, Claude Code, or another coding-agent runtime. `list_files` and `search_text` use bounded Node.js filesystem operations, while the Git tools invoke the host's `git` executable with argument arrays rather than shell interpolation.

Direct file tools accept workspace-relative paths only. Absolute paths, `..` traversal, NUL bytes, and symbolic-link escapes are rejected. The workspace cannot be a filesystem root or the user's home directory. `apply_patch` uses structured create/replace/delete operations: replacements must match exactly once, optional SHA-256 baselines prevent stale writes, all operations are validated before mutation, and failed multi-file commits are rolled back.

`workspace.read` grants file inspection, search, and read-only Git tools. `workspace.write` grants `apply_patch`. These scopes are intentionally separate from `command.run`: command execution remains host-level and can still access everything allowed to the service account.

Example structured patch:

```json
{
  "changes": [
    {
      "type": "replace",
      "path": "src/index.ts",
      "oldText": "const port = 3000;",
      "newText": "const port = 8080;",
      "expectedSha256": "SHA-256 returned by read_file"
    }
  ]
}
```

## cloudflared and frpc

```powershell
secure-host-mcp tunnel inspect
secure-host-mcp tunnel install-plan cloudflared
secure-host-mcp tunnel install-plan frpc
secure-host-mcp tunnel install cloudflared --yes
secure-host-mcp tunnel start cloudflared
```

The inspector searches PATH and standard cloudflared configuration directories. External-runtime detection currently covers only the official default Windows service named `Cloudflared` and the Linux `cloudflared.service` unit; custom service names, template units, bare processes, and macOS launchd services are not detected. Set `tunnels.frpcConfig` for frpc. Parsed configuration is recursively redacted. `frpc verify -c` runs before launch. `tunnels.proxyUrl` is passed as `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY`, including `socks5://` URLs supported by the selected tunnel client.

The install command requires `--yes`, downloads only the matching official GitHub Release asset, requires its published SHA-256 digest, verifies it, and installs to the application data directory. Without confirmation it fails closed.

## Privileged helper

Normal service-account execution is the default. To enable per-command elevation, start the helper separately from an already elevated terminal:

```powershell
# Windows: run PowerShell as Administrator
secure-host-mcp helper
```

```bash
sudo secure-host-mcp helper
```

The helper listens only on `127.0.0.1:8769`, authenticates with a random key from the restricted secrets file, independently verifies that it is elevated, and audits complete command input/output. `set_admin_mode(enabled=true)` asks the helper to persist the mode, stop the ordinary instance, and start a new root/Administrator instance. Returning to a lower-privilege account requires restoring the configured Windows Service/systemd account locally; configuration alone is never treated as proof of elevation.

## Security choices

- The configured administrator token has all scopes and is accepted by the web console, OAuth approval page, and direct MCP Bearer authentication.
- `~/.secure-host-mcp/tokens.json` is the single registry for the administrator token and direct MCP connection tokens. OAuth grants and helper secrets live separately in `secrets.json`. Both files must use mode `0600` on POSIX. Back them up and protect them.
- Audit logs default to `audit.contentMode: "redacted"` and remove configured token values, Bearer credentials, helper secrets, and common password/token/secret/key assignments before disk writes. `metadata` stores only outcome, byte counts, and truncation metadata; `full` stores command/output content verbatim and can leak credentials. Logs rotate by size/day and are retained for 30 days under the data directory. PTY input content is never logged by default—only its byte count.
- Coding file tools remain confined to `coding.root`; this boundary does not restrict the host-level command and elevation tools.
- MCP and administration listen on all interfaces by default. Every administration API request requires the administrator bearer token, and mutations also require the page CSRF token.
- Public HTTP is not encrypted: authentication controls access but cannot prevent interception of bearer tokens, OAuth codes, or administration traffic. Prefer HTTPS or a trusted VPN.
- Tool annotations ask compatible clients to confirm destructive operations. The host cannot prove that a client actually displayed a human confirmation.

## Configuration

Set `SECURE_HOST_MCP_HOME` to change the data directory. Copy fields from `config.example.json` into the generated `config.json`, then restart. Configuration and secrets are written atomically.

The coding workspace is enabled by default. Existing installations without a `coding.root` use `<dataDir>/workspace`; set an explicit project parent and restart to expose existing repositories:

```json
{
  "coding": {
    "enabled": true,
    "root": "/srv/projects",
    "maxReadBytes": 524288,
    "maxSearchResults": 1000,
    "maxPatchBytes": 1048576
  }
}
```

Runtime and audit limits can be adjusted independently:

```json
{
  "execution": {
    "maxTerminals": 4,
    "maxTerminalOutputBytes": 1048576,
    "terminalIdleTtlMs": 1800000,
    "runtimeHistoryLimit": 100
  },
  "audit": {
    "contentMode": "redacted",
    "sensitiveKeys": ["authorization", "password", "token", "secret", "api_key", "private_key"]
  }
}
```

The redacted runtime summary is stored atomically as `runtime-state.json` in the application data directory with restricted POSIX permissions. It is context for auditing and reconnects, not cross-restart process supervision.

The generated `tokens.json` is intentionally editable:

```json
{
  "version": 1,
  "adminToken": "my-admin-token",
  "connectionTokens": [
    {
      "id": "second-agent",
      "token": "agent-2-token",
      "label": "Second agent",
      "scopes": ["system.read", "command.run"]
    }
  ]
}
```

Change `adminToken` to rotate the administrator token, or append entries to `connectionTokens` to create more direct MCP Bearer tokens. `id` is optional for manually added tokens; when omitted, the service derives a stable identifier from the token value. Token values have no pattern requirement but must be non-empty and unique. Scopes must come from `system.read`, `command.run`, `command.elevate`, `workspace.read`, `workspace.write`, `tunnel.read`, `tunnel.manage`, and `admin.manage`. Restart Secure Host MCP after manual edits. See `tokens.example.json` for a full-access example.

For a loopback-only deployment, explicitly set both `mcp.host` and `admin.host` to `127.0.0.1`. New installations enable remote administration by default.

External OIDC can be enabled with `auth.externalIssuer` and `auth.externalAudience`. Tokens are verified against the issuer JWKS and mapped to the same MCP scopes.

## Development

```powershell
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Standalone release builds use `npm run package:standalone`. Cross-platform artifacts should be produced and checksummed in release CI.

## Publishing a release

Use Conventional Commit prefixes such as `fix:`, `feat:`, and `feat!:` when merging product changes into `main`. Release Please automatically creates or updates a Release PR containing the next `package.json`/lockfile version and `CHANGELOG.md`. While the project is below `1.0.0`, both `fix:` and `feat:` produce patch releases; breaking changes retain their normal SemVer meaning.

Merging the Release PR creates the matching `v<version>` tag and GitHub Release. The release workflow then tests and packages Windows x64, Linux x64, and macOS arm64, creates checksums, uploads all three assets to that Release, and publishes the same version to npm.

By default the Release PR waits for a manual merge, keeping an explicit review gate. When the `RELEASE_PLEASE_TOKEN` secret (a fine-grained PAT with Actions, contents, and pull-request read/write access) is configured, the workflow approves the validation runs that GitHub holds for a `GITHUB_TOKEN`-created Release PR and then enables GitHub auto-merge. The PR merges on its own once the required status checks pass. Auto-merge additionally requires the repository setting "Allow auto-merge" and a `main` branch protection rule with required status checks — without required checks, auto-merge would not wait for CI.

Explicit matching tags and guarded manual workflow runs remain available for recovery and prereleases. Prerelease versions use npm's `next` dist-tag; stable versions use `latest`.

The npm job uses Trusted Publishing with GitHub OIDC and does not require a long-lived npm token in repository secrets. A manual workflow run defaults to validation only and will not publish unless explicitly enabled.
