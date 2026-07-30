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
  <a href="README.md">English</a> | 简体中文
</p>

Secure Host MCP 通过 Streamable HTTP 将 Windows、Linux 或 macOS 主机终端和代码工作区开放给远程 MCP 客户端。它有意提供接近本机的强大能力：默认管理员令牌可以编辑代码、检查 Git、执行服务账户有权运行的任何命令、检查或启动已配置的隧道，以及请求提权操作。

## 下载独立发行包

从 [GitHub Releases](https://github.com/Razewang/secure-host-mcp/releases/latest) 下载对应平台的压缩包：

- Windows x64：解压 ZIP 后双击 `secure-host-mcp.exe`。首次运行时，控制台向导会询问公网 IP 与 Cloudflare Tunnel、配置管理员令牌、显示连接地址，然后启动 MCP 与管理服务。
- Linux x64：解压 `tar.gz` 后运行 `./secure-host-mcp launch`，完成相同的首次初始化与启动流程。
- macOS Apple Silicon：解压 `tar.gz` 后运行 `./secure-host-mcp launch`。当前仅提供 arm64 Mac 版本。

这些压缩包不需要另外安装 Node.js。Windows EXE 暂未进行代码签名，因此 Microsoft Defender SmartScreen 可能显示“未知发布者”警告。运行前请使用 `SHA256SUMS.txt` 校验下载文件。

```powershell
# Windows PowerShell
(Get-FileHash .\secure-host-mcp-0.1.0-windows-x64.zip -Algorithm SHA256).Hash
```

```bash
# Linux / macOS
sha256sum -c SHA256SUMS.txt --ignore-missing
```

## 安装与首次配置

通过 npm 安装时需要 Node.js 20 或更高版本：

```powershell
npm install -g secure-host-mcp
secure-host-mcp setup --public-url https://mcp.example.com --workspace /srv/projects
secure-host-mcp doctor
secure-host-mcp start
```

> **首次配置引导：第一条命令是 `setup`，不是 `start`。**
>
> 全新安装还没有管理员令牌。`setup` 负责创建令牌（写入 `tokens.json`）、生成基础配置并打印连接地址；`start` 只负责启动已完成配置的服务——在从未运行过 `setup` 的机器上，它会立即报错退出：`ADMIN_TOKEN_MISSING: Run setup before starting the server`。
>
> 因此首次使用的完整流程是：**1.** `setup`（每台机器只需一次）→ **2.** `doctor`（可选的健康检查）→ **3.** `start`（此后每次启动）。如果希望一条命令完成，可以使用 `secure-host-mcp launch`：它会在需要时自动执行首次配置再启动服务，与独立发行包中双击 `secure-host-mcp.exe` 的行为一致。

### 进程启动与停止

`start` 仍默认以前台方式运行；添加 `--daemon` 后会脱离当前终端，将标准输出和错误写入应用日志，并在后台进程报告启动成功后返回：

```powershell
# 前台启动，按 Ctrl+C 停止
secure-host-mcp start

# 后台启动
secure-host-mcp start --daemon

# 查看、停止和重启托管进程
secure-host-mcp status
secure-host-mcp status --json
secure-host-mcp stop
secure-host-mcp restart

# 仅在优雅停止超时时使用
secure-host-mcp stop --force
secure-host-mcp restart --force
```

`secure-host-mcp launch --daemon` 可以在需要时完成首次配置，然后直接进入后台运行。PID 状态保存在 `SECURE_HOST_MCP_HOME` 下的 `service-state.json`，后台输出保存在 `service.log`；默认目录为 `~/.secure-host-mcp`。进程异常退出后，`status` 会自动清理陈旧 PID。生命周期命令只管理使用同一应用数据目录启动的 Secure Host MCP，不会自动安装系统服务，也不会停止无关的 Node.js 进程。

在交互式终端中进行全新安装时，`setup` 会：

1. 询问设备是否拥有可直接访问的公网 IP，并尽可能通过 Cloudflare trace 接口自动检测。
2. 检查 `cloudflared`；未安装时询问是否下载经过官方 SHA-256 摘要校验的版本。这里只安装程序，不会代替用户创建 Cloudflare 账户或隧道配置。
3. 让用户选择自动生成初始令牌，或者手动输入任意非空令牌。令牌没有固定格式，纯数字、纯字母或混合形式均可。
4. 明确提示：这个初始令牌同时是网页控制台管理员令牌，也是拥有完整权限的 MCP Bearer 连接 Token。
5. 询问允许远程编码工具访问的目录；默认使用应用数据目录下独立的 `workspace` 目录。
6. 检测到公网 IP 后，自动显示由该 IP 组成的 MCP 地址、网页控制台地址以及 HTTP 明文传输警告。

非交互式安装仍兼容自动化脚本：它会自动生成令牌，但不会自动安装 Cloudflare。新安装默认监听全部网络接口，只要主机防火墙、路由器和云安全组允许，远程客户端即可连接。

默认端点：

- MCP 与 OAuth：`http://0.0.0.0:8767/mcp`
- 管理界面：`http://0.0.0.0:8768/`

`0.0.0.0` 是监听地址，不是客户端应填写的连接地址；客户端应使用服务器 IP 或域名。即使尚未配置 HTTPS，两个服务仍会启动，但鉴权并不能加密 Bearer 令牌、OAuth 授权码或管理流量。ChatGPT 要求 MCP 地址能够通过公网 HTTPS 访问。请在 8767 端口前部署 Caddy、Nginx、Cloudflare Tunnel、frp 或其他可信反向代理，并使用 HTTPS 或可信私有网络保护 8768 端口的远程管理。`examples/` 中提供了一个最小 Caddy 配置示例。

访问管理地址并输入管理员令牌后，会打开中英文响应式管理面板。它可以查看主机资源和运行配置、创建及吊销带权限范围的连接 Token，以及控制已配置的 frpc/cloudflared 进程。通过面板创建的连接 Token 会写入首次配置和手动配置共用的 `tokens.json` 注册表。

例如检测到 `203.0.113.10` 时，向导会显示：

```text
Public MCP URL: http://203.0.113.10:8767/mcp
Web console URL: http://203.0.113.10:8768/
WARNING: HTTP is plaintext...
```

## 连接 ChatGPT OAuth

将 `https://mcp.example.com/mcp` 填为服务器地址并选择 OAuth。服务器会发布授权服务器和受保护资源元数据。新客户端可以动态注册；随后 ChatGPT 打开授权页面，由主机管理员输入管理员令牌并批准所需权限范围。服务器使用授权码加 PKCE 流程，并签发支持离线访问的轮换刷新令牌。

ChatGPT 中完整的可写 MCP 支持取决于账户或工作区方案，以及当前 Developer Mode 的开放情况。

## 终端与后台任务

单次命令和后台任务的主要 MCP 工具包括 `execute_command`、`start_job`、`job_status`、`read_job_output`、`write_job_input` 和 `cancel_job`。如需真正持久的 PTY，可使用 `create_terminal`、`read_terminal`、`write_terminal`、`resize_terminal`、`interrupt_terminal` 和 `close_terminal`。Windows 使用 ConPTY，并优先选择 PowerShell 7，否则使用 Windows PowerShell；Linux 与 macOS 默认使用 `/bin/bash`，也可以通过配置修改。

PTY 输出保存在有界环形缓冲区中，并使用单调递增的字节游标。请求的游标已经过期时，`read_terminal` 会返回当前 `startOffset` 与 `droppedBytes`，避免客户端把截断输出误认为完整记录。MCP 断开后，终端仍会继续运行，直到进程退出、被关闭或达到空闲 TTL。Secure Host 进程重启会终止其管理的进程，只恢复经过脱敏并标记为 `interrupted` 的摘要，不会声称底层进程仍然存活。

Job 与终端归创建它们的 Token 或 OAuth 主体所有。普通 `command.run` 主体只能访问自己的记录；具有 `admin.manage` 的主体可以查看和停止全部记录。越权查询与不存在的标识统一返回同一种未找到错误。

`runtime_snapshot` 是只读的 `system.read` 工具。它始终返回主机状态；调用者同时拥有 `command.run` 时返回其可见的 Job/PTY 记录，同时拥有 `workspace.read` 时返回工作区与 Git 状态。支持 MCP Apps 的客户端还可以通过版本化资源 `ui://secure-host/runtime-status-v1.html` 渲染只读状态卡片；其他客户端仍会收到相同的文本与 `structuredContent`。该卡片不包含执行、终止、审批或后台轮询操作。

命令不经过沙箱或白名单限制。除非确实需要完整的用户或 root 权限，否则请让服务运行在专用账户下。`execute_elevated` 默认采用失败关闭策略：只有进程本身已经提权，或已安装特权辅助进程时才可执行。`set_admin_mode` 只记录请求；服务重配置必须由已安装的服务适配器或本地 CLI 实际应用。

## 远程代码工作区

当 `coding.enabled` 为 `true` 时，MCP 还会提供：

- `workspace_info`、`read_file`、`list_directory`、`list_files`、`search_text`
- `apply_patch`
- `git_status`、`git_diff`、`git_log`、`git_show`、`git_blame`

这些工具使用 TypeScript 独立实现，不包含 Codex、Claude Code 或其他编程 Agent 运行时。`list_files` 和 `search_text` 使用有数量限制的 Node.js 文件系统操作；Git 工具通过参数数组调用主机的 `git`，不会把参数拼接到 Shell 命令中。

直接文件工具只接受相对于工作区的路径，并拒绝绝对路径、`..` 穿越、NUL 字节与符号链接逃逸。不能把文件系统根目录或用户主目录直接设置为工作区。`apply_patch` 使用结构化的创建、替换和删除操作：替换内容必须仅匹配一次，可使用 `read_file` 返回的 SHA-256 防止覆盖并发修改；全部变更会在写入前完成验证，多文件提交失败时会回滚。

`workspace.read` 允许读取文件、搜索和使用只读 Git 工具；`workspace.write` 允许调用 `apply_patch`。它们与 `command.run` 有意分离：命令执行仍是主机级能力，可以访问服务账户本身有权访问的所有位置。

结构化补丁示例：

```json
{
  "changes": [
    {
      "type": "replace",
      "path": "src/index.ts",
      "oldText": "const port = 3000;",
      "newText": "const port = 8080;",
      "expectedSha256": "read_file 返回的 SHA-256"
    }
  ]
}
```

## cloudflared 与 frpc

```powershell
secure-host-mcp tunnel inspect
secure-host-mcp tunnel install-plan cloudflared
secure-host-mcp tunnel install-plan frpc
secure-host-mcp tunnel install cloudflared --yes
secure-host-mcp tunnel start cloudflared
```

检查器会搜索 PATH 和 cloudflared 的标准配置目录。外部运行状态目前只检测名为 `Cloudflared` 的官方默认 Windows 服务和 Linux 的 `cloudflared.service`；自定义服务名、模板 unit、裸进程以及 macOS launchd 服务不会被检测。frpc 配置文件位置通过 `tunnels.frpcConfig` 设置，解析后的配置会递归隐藏敏感字段。启动 frpc 前会运行 `frpc verify -c`。`tunnels.proxyUrl` 会以 `HTTP_PROXY`、`HTTPS_PROXY` 和 `ALL_PROXY` 环境变量传给隧道客户端，也支持客户端可识别的 `socks5://` 地址。

安装命令必须显式传入 `--yes`。它只下载与当前平台匹配的官方 GitHub Release 文件，要求发布方提供 SHA-256 摘要，校验成功后才安装到应用数据目录；未确认时会直接拒绝安装。

## 特权辅助进程

默认情况下，命令使用普通服务账户执行。如需逐条命令提权，请在已经提权的终端中单独启动辅助进程：

```powershell
# Windows：以管理员身份运行 PowerShell
secure-host-mcp helper
```

```bash
sudo secure-host-mcp helper
```

辅助进程只监听 `127.0.0.1:8769`，使用受限密钥文件中的随机密钥鉴权，并独立验证自身是否具有管理员权限。完整的命令输入与输出都会进入审计日志。`set_admin_mode(enabled=true)` 会要求辅助进程持久化该模式、停止普通实例，并启动新的 root 或 Administrator 实例。若要恢复低权限账户，必须在本地恢复 Windows 服务或 systemd 的账户设置；仅修改配置不能作为已经提权的证明。

## 安全设计

- 管理员令牌拥有全部权限，可用于网页控制台、OAuth 授权确认页面以及直接 MCP Bearer 鉴权。
- `~/.secure-host-mcp/tokens.json` 是管理员令牌和直接 MCP 连接 Token 的唯一注册表；OAuth 授权与辅助进程密钥单独保存在 `secrets.json`。POSIX 系统要求这两个文件的权限均为 `0600`，请妥善备份和保护。
- 审计日志默认使用 `audit.contentMode: "redacted"`，在落盘前隐藏已配置 Token、Bearer 凭据、辅助进程密钥，以及常见 password/token/secret/key 赋值。`metadata` 只保存结果、字节数和截断元数据；`full` 会原样保存命令与输出，可能泄露凭据。日志按日期和大小轮换，并在数据目录中保留 30 天。PTY 输入正文默认永不记录，只记录写入字节数。
- 编码文件工具始终限制在 `coding.root` 内；这个边界不会限制主机级命令与提权工具。
- MCP 与管理端默认监听全部网络接口。每个管理 API 请求都必须携带管理员 Bearer 令牌，写操作还必须携带页面 CSRF 令牌。
- 公网 HTTP 不提供加密：鉴权可以控制访问权限，但无法阻止 Bearer 令牌、OAuth 授权码或管理流量被网络窃听。应优先使用 HTTPS 或可信 VPN。
- 工具注解会要求兼容客户端在破坏性操作前进行确认，但主机端无法证明客户端确实向用户显示了确认界面。

## 配置

设置 `SECURE_HOST_MCP_HOME` 可以更改数据目录。将 `config.example.json` 中需要的字段复制到自动生成的 `config.json`，然后重启服务。配置与密钥均采用原子写入。

代码工作区默认启用。旧配置没有 `coding.root` 时使用 `<dataDir>/workspace`；如需访问已有仓库，请设置明确的项目父目录并重启：

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

运行时和审计限制可以分别调整：

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

经过脱敏的运行时摘要会以原子写入方式保存在应用数据目录的 `runtime-state.json` 中，并在 POSIX 上使用受限权限。它用于审计和重连上下文，不是跨重启进程托管。

自动生成的 `tokens.json` 可以直接编辑：

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

修改 `adminToken` 即可轮换管理员令牌；向 `connectionTokens` 添加项目即可创建更多 MCP Bearer 连接 Token。手动添加的 Token 可以省略 `id`，服务会根据 Token 值派生稳定标识。Token 没有格式限制，但不能为空且不能重复。权限范围只能取自 `system.read`、`command.run`、`command.elevate`、`workspace.read`、`workspace.write`、`tunnel.read`、`tunnel.manage` 和 `admin.manage`。手动编辑后需要重启 Secure Host MCP。完整权限示例见 `tokens.example.json`。

如需仅本机访问，请在配置中明确将 `mcp.host` 和 `admin.host` 都设置为 `127.0.0.1`。新安装默认允许远程管理。

可以通过 `auth.externalIssuer` 和 `auth.externalAudience` 启用外部 OIDC。令牌会使用发行方 JWKS 验证，并映射到相同的 MCP 权限范围。

## 开发

```powershell
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

使用 `npm run package:standalone` 构建独立发行包。跨平台产物应在 Release CI 中生成并计算校验和。

## 发布新版本

向 `main` 合并产品改动时，请使用 `fix:`、`feat:`、`feat!:` 等 Conventional Commit 前缀。Release Please 会自动创建或更新 Release PR，其中包含下一版本的 `package.json`、锁文件和 `CHANGELOG.md`。项目版本低于 `1.0.0` 时，`fix:` 与 `feat:` 都生成补丁版本；破坏性改动仍遵循正常的 SemVer 规则。

合并 Release PR 后，Release Please 会创建匹配的 `v<version>` 标签和 GitHub Release。发布工作流随后测试并打包 Windows x64、Linux x64 与 macOS arm64，生成校验和、向该 Release 上传三个平台产物，并向 npm 发布相同版本。

默认情况下 Release PR 需要人工合并，保留一次发布前审核。配置 `RELEASE_PLEASE_TOKEN` 密钥（具备 Actions、contents 与 pull requests 读写权限的细粒度 PAT）后，工作流会先批准 GitHub 为 `GITHUB_TOKEN` 创建的 Release PR 暂停等待授权的验证任务，再开启 GitHub 自动合并；所有必需状态检查通过后即自动合并并发布。启用自动合并还需要在仓库设置中打开“Allow auto-merge”，并为 `main` 分支配置带必需状态检查的保护规则——没有必需检查时，自动合并不会等待 CI。

完全匹配的显式标签和受保护的手动工作流仍可用于恢复与预发行。预发行版本使用 npm 的 `next` 标签，正式版本使用 `latest`。

npm 发布任务使用 GitHub OIDC Trusted Publishing，不需要在仓库 Secrets 中保存长期 npm 令牌。手动运行工作流时默认只做构建验证，除非明确开启发布，否则不会产生公开版本。
