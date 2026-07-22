# Secure Host MCP

Secure Host MCP exposes a Windows or Linux host terminal to remote MCP clients through Streamable HTTP. It is intentionally powerful: the default owner token can execute any command available to the service account, inspect or launch configured tunnels, and request privileged operations.

## Install and first setup

Requires Node.js 20 or newer when installed through npm:

```powershell
npm install -g secure-host-mcp
secure-host-mcp setup --public-url https://mcp.example.com
secure-host-mcp doctor
secure-host-mcp start
```

`setup` prints the owner token once. Store it securely. It is used for direct Bearer authentication, the OAuth approval page, and the administration UI.

Endpoints default to:

- MCP and OAuth: `http://127.0.0.1:8767/mcp`
- Administration: `http://127.0.0.1:8768/`

ChatGPT requires a remotely reachable HTTPS MCP URL. Put Caddy, Nginx, Cloudflare Tunnel, frp, or another trusted reverse proxy in front of port 8767. A minimal Caddy example is under `examples/`.

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
- LAN HTTP administration is available with `setup --allow-lan-http`, but exposes login material to network interception. Prefer HTTPS or a trusted VPN.
- Tool annotations ask compatible clients to confirm destructive operations. The host cannot prove that a client actually displayed a human confirmation.

## Configuration

Set `SECURE_HOST_MCP_HOME` to change the data directory. Copy fields from `config.example.json` into the generated `config.json`, then restart. Configuration and secrets are written atomically.

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
