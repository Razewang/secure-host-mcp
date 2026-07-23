# Secure Host MCP

<p align="center">
  <a href="https://github.com/Razewang/secure-host-mcp/actions/workflows/ci.yml"><img src="https://github.com/Razewang/secure-host-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Razewang/secure-host-mcp/releases/latest"><img src="https://img.shields.io/github/v/release/Razewang/secure-host-mcp?label=Release" alt="Latest release"></a>
  <a href="https://www.npmjs.com/package/secure-host-mcp"><img src="https://img.shields.io/npm/v/secure-host-mcp?logo=npm" alt="npm"></a>
  <img src="https://img.shields.io/badge/Windows-x64-0078D4?logo=windows" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-FCC624?logo=linux&logoColor=000000" alt="Linux x64">
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 20+">
  <img src="https://img.shields.io/badge/MCP-Streamable%20HTTP-5A45FF" alt="MCP Streamable HTTP">
  <a href="https://github.com/Razewang/secure-host-mcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

Secure Host MCP exposes a Windows or Linux host terminal to remote MCP clients through Streamable HTTP. It is intentionally powerful: the default owner token can execute any command available to the service account, inspect or launch configured tunnels, and request privileged operations.

## Download a standalone release

Download the archive for your platform from [GitHub Releases](https://github.com/Razewang/secure-host-mcp/releases/latest):

- Windows x64: extract the ZIP and double-click `secure-host-mcp.exe`. On first launch it creates the configuration, displays the owner token once, and starts the MCP and administration servers in a console window.
- Linux x64: extract the `tar.gz` archive and run `./secure-host-mcp launch` for the same first-run initialization and startup behavior.

No separate Node.js installation is required for these archives. The Windows executable is not code-signed yet, so Microsoft Defender SmartScreen may display an unknown-publisher warning. Verify the download against `SHA256SUMS.txt` before running it.

```powershell
# Windows PowerShell
(Get-FileHash .\secure-host-mcp-0.1.0-windows-x64.zip -Algorithm SHA256).Hash
```

```bash
# Linux
sha256sum -c SHA256SUMS.txt --ignore-missing
```

## Install and first setup

Requires Node.js 20 or newer when installed through npm:

```powershell
npm install -g secure-host-mcp
secure-host-mcp setup --public-url https://mcp.example.com
secure-host-mcp doctor
secure-host-mcp start
```

`setup` prints the owner token once. Store it securely. It is used for direct Bearer authentication, the OAuth approval page, and the administration UI. New installations listen on all network interfaces by default so remote clients can connect when the host firewall, router, and cloud security rules permit it.

Endpoints default to:

- MCP and OAuth: `http://0.0.0.0:8767/mcp`
- Administration: `http://0.0.0.0:8768/`

`0.0.0.0` is a bind address, not a client URL. Connect with the server's IP address or DNS name. Both services start even when HTTPS is not configured, but authentication does not encrypt bearer tokens, OAuth codes, or administration traffic. ChatGPT requires a remotely reachable HTTPS MCP URL. Put Caddy, Nginx, Cloudflare Tunnel, frp, or another trusted reverse proxy in front of port 8767, and protect remote administration on port 8768 with HTTPS or a trusted private network. A minimal Caddy example is under `examples/`.

## ChatGPT OAuth connection

Use `https://mcp.example.com/mcp` as the server URL and choose OAuth. The server publishes its authorization and protected-resource metadata. A new client dynamically registers, ChatGPT opens the authorization page, and the host owner enters the owner token and approves the requested scopes. The server uses authorization code + PKCE and issues rotating refresh tokens with offline access.

Full write-capable MCP support in ChatGPT depends on the account/workspace plan and current Developer Mode availability.

## Terminal and jobs

The main MCP tools are `execute_command`, `start_job`, `job_status`, `read_job_output`, and `cancel_job`. Windows uses PowerShell 7 when available and Windows PowerShell otherwise. Linux uses `/bin/bash` unless configured differently.

Commands are not sandboxed or allowlisted. Run the service under a dedicated account unless full user/root access is intentional. `execute_elevated` fails closed until the process is already elevated or a privileged helper is installed. `set_admin_mode` records the request; service reconfiguration must be applied by an installed service adapter or the local CLI.

## cloudflared and frpc

```powershell
secure-host-mcp tunnel inspect
secure-host-mcp tunnel install-plan cloudflared
secure-host-mcp tunnel install-plan frpc
secure-host-mcp tunnel install cloudflared --yes
secure-host-mcp tunnel start cloudflared
```

The inspector searches PATH and standard cloudflared configuration directories. Set `tunnels.frpcConfig` for frpc. Parsed configuration is recursively redacted. `frpc verify -c` runs before launch. `tunnels.proxyUrl` is passed as `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY`, including `socks5://` URLs supported by the selected tunnel client.

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

- The generated owner token has all scopes. Additional scoped tokens can be added to the restricted secrets store.
- Secrets live in `~/.secure-host-mcp/secrets.json`; POSIX permissions must be `0600`. Back up and protect this file.
- Audit logs intentionally contain complete commands and stdout/stderr in plaintext. They rotate by size/day and are retained for 30 days under the data directory.
- MCP and administration listen on all interfaces by default. Every administration API request requires the owner bearer token, and mutations also require the page CSRF token.
- Public HTTP is not encrypted: authentication controls access but cannot prevent interception of bearer tokens, OAuth codes, or administration traffic. Prefer HTTPS or a trusted VPN.
- Tool annotations ask compatible clients to confirm destructive operations. The host cannot prove that a client actually displayed a human confirmation.

## Configuration

Set `SECURE_HOST_MCP_HOME` to change the data directory. Copy fields from `config.example.json` into the generated `config.json`, then restart. Configuration and secrets are written atomically.

For a loopback-only deployment, explicitly set both `mcp.host` and `admin.host` to `127.0.0.1`. Existing configuration files are preserved during upgrades and are not silently changed to public listeners. The legacy `setup --allow-lan-http` option remains accepted for compatibility; remote administration is already enabled for new installations.

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

Merging the Release PR creates the matching `v<version>` tag and GitHub Release. The release workflow then tests and packages both platforms, creates checksums, uploads the Windows/Linux assets to that Release, and publishes the same version to npm. The Release PR is never merged automatically, so publication retains an explicit review gate.

Explicit matching tags and guarded manual workflow runs remain available for recovery and prereleases. Prerelease versions use npm's `next` dist-tag; stable versions use `latest`.

The npm job uses Trusted Publishing with GitHub OIDC and does not require a long-lived npm token in repository secrets. A manual workflow run defaults to validation only and will not publish unless explicitly enabled.
