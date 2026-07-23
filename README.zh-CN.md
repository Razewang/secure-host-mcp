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
  <a href="README.md">English</a> | 简体中文
</p>

Secure Host MCP 通过 Streamable HTTP 将 Windows 或 Linux 主机终端开放给远程 MCP 客户端。它有意提供接近本机终端的强大能力：默认管理员令牌可以执行服务账户有权运行的任何命令、检查或启动已配置的隧道，以及请求提权操作。

## 下载独立发行包

从 [GitHub Releases](https://github.com/Razewang/secure-host-mcp/releases/latest) 下载对应平台的压缩包：

- Windows x64：解压 ZIP 后双击 `secure-host-mcp.exe`。首次运行时，控制台向导会询问公网 IP 与 Cloudflare Tunnel、配置管理员令牌、显示连接地址，然后启动 MCP 与管理服务。
- Linux x64：解压 `tar.gz` 后运行 `./secure-host-mcp launch`，完成相同的首次初始化与启动流程。

这些压缩包不需要另外安装 Node.js。Windows EXE 暂未进行代码签名，因此 Microsoft Defender SmartScreen 可能显示“未知发布者”警告。运行前请使用 `SHA256SUMS.txt` 校验下载文件。

```powershell
# Windows PowerShell
(Get-FileHash .\secure-host-mcp-0.1.0-windows-x64.zip -Algorithm SHA256).Hash
```

```bash
# Linux
sha256sum -c SHA256SUMS.txt --ignore-missing
```

## 安装与首次配置

通过 npm 安装时需要 Node.js 20 或更高版本：

```powershell
npm install -g secure-host-mcp
secure-host-mcp setup --public-url https://mcp.example.com
secure-host-mcp doctor
secure-host-mcp start
```

在交互式终端中进行全新安装时，`setup` 会：

1. 询问设备是否拥有可直接访问的公网 IP，并尽可能通过 Cloudflare trace 接口自动检测。
2. 检查 `cloudflared`；未安装时询问是否下载经过官方 SHA-256 摘要校验的版本。这里只安装程序，不会代替用户创建 Cloudflare 账户或隧道配置。
3. 让用户选择自动生成初始令牌，或者手动输入任意非空令牌。令牌没有固定格式，纯数字、纯字母或混合形式均可。
4. 明确提示：这个初始令牌同时是网页控制台管理员令牌，也是拥有完整权限的 MCP Bearer 连接 Token。
5. 检测到公网 IP 后，自动显示由该 IP 组成的 MCP 地址、网页控制台地址以及 HTTP 明文传输警告。

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

主要 MCP 工具包括 `execute_command`、`start_job`、`job_status`、`read_job_output` 和 `cancel_job`。Windows 优先使用 PowerShell 7，否则使用 Windows PowerShell；Linux 默认使用 `/bin/bash`，也可以通过配置修改。

命令不经过沙箱或白名单限制。除非确实需要完整的用户或 root 权限，否则请让服务运行在专用账户下。`execute_elevated` 默认采用失败关闭策略：只有进程本身已经提权，或已安装特权辅助进程时才可执行。`set_admin_mode` 只记录请求；服务重配置必须由已安装的服务适配器或本地 CLI 实际应用。

## cloudflared 与 frpc

```powershell
secure-host-mcp tunnel inspect
secure-host-mcp tunnel install-plan cloudflared
secure-host-mcp tunnel install-plan frpc
secure-host-mcp tunnel install cloudflared --yes
secure-host-mcp tunnel start cloudflared
```

检查器会搜索 PATH 和 cloudflared 的标准配置目录。frpc 配置文件位置通过 `tunnels.frpcConfig` 设置，解析后的配置会递归隐藏敏感字段。启动 frpc 前会运行 `frpc verify -c`。`tunnels.proxyUrl` 会以 `HTTP_PROXY`、`HTTPS_PROXY` 和 `ALL_PROXY` 环境变量传给隧道客户端，也支持客户端可识别的 `socks5://` 地址。

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
- 审计日志会有意以明文记录完整命令及 stdout/stderr。日志按日期和大小轮换，并在数据目录中保留 30 天。
- MCP 与管理端默认监听全部网络接口。每个管理 API 请求都必须携带管理员 Bearer 令牌，写操作还必须携带页面 CSRF 令牌。
- 公网 HTTP 不提供加密：鉴权可以控制访问权限，但无法阻止 Bearer 令牌、OAuth 授权码或管理流量被网络窃听。应优先使用 HTTPS 或可信 VPN。
- 工具注解会要求兼容客户端在破坏性操作前进行确认，但主机端无法证明客户端确实向用户显示了确认界面。

## 配置

设置 `SECURE_HOST_MCP_HOME` 可以更改数据目录。将 `config.example.json` 中需要的字段复制到自动生成的 `config.json`，然后重启服务。配置与密钥均采用原子写入。

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

修改 `adminToken` 即可轮换管理员令牌；向 `connectionTokens` 添加项目即可创建更多 MCP Bearer 连接 Token。手动添加的 Token 可以省略 `id`，服务会根据 Token 值派生稳定标识。Token 没有格式限制，但不能为空且不能重复。权限范围只能取自 `system.read`、`command.run`、`command.elevate`、`tunnel.read`、`tunnel.manage` 和 `admin.manage`。手动编辑后需要重启 Secure Host MCP。完整权限示例见 `tokens.example.json`。

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

合并 Release PR 后，Release Please 会创建匹配的 `v<version>` 标签和 GitHub Release。发布工作流随后测试并打包两个平台、生成校验和、向该 Release 上传 Windows/Linux 产物，并向 npm 发布相同版本。Release PR 不会自动合并，因此正式发布始终保留一次人工审核。

完全匹配的显式标签和受保护的手动工作流仍可用于恢复与预发行。预发行版本使用 npm 的 `next` 标签，正式版本使用 `latest`。

npm 发布任务使用 GitHub OIDC Trusted Publishing，不需要在仓库 Secrets 中保存长期 npm 令牌。手动运行工作流时默认只做构建验证，除非明确开启发布，否则不会产生公开版本。
