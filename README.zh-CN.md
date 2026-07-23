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

Secure Host MCP 通过 Streamable HTTP 将 Windows 或 Linux 主机终端开放给远程 MCP 客户端。它有意提供接近本机终端的强大能力：默认所有者令牌可以执行服务账户有权运行的任何命令、检查或启动已配置的隧道，以及请求提权操作。

## 下载独立发行包

从 [GitHub Releases](https://github.com/Razewang/secure-host-mcp/releases/latest) 下载对应平台的压缩包：

- Windows x64：解压 ZIP 后双击 `secure-host-mcp.exe`。首次运行会创建配置、显示一次所有者令牌，并在控制台窗口中启动 MCP 与管理服务。
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

`setup` 只会显示一次所有者令牌，请妥善保存。该令牌可用于直接 Bearer 鉴权、OAuth 授权确认页面以及管理界面。新安装默认监听全部网络接口，只要主机防火墙、路由器和云安全组允许，远程客户端即可连接。

默认端点：

- MCP 与 OAuth：`http://0.0.0.0:8767/mcp`
- 管理界面：`http://0.0.0.0:8768/`

`0.0.0.0` 是监听地址，不是客户端应填写的连接地址；客户端应使用服务器 IP 或域名。即使尚未配置 HTTPS，两个服务仍会启动，但鉴权并不能加密 Bearer 令牌、OAuth 授权码或管理流量。ChatGPT 要求 MCP 地址能够通过公网 HTTPS 访问。请在 8767 端口前部署 Caddy、Nginx、Cloudflare Tunnel、frp 或其他可信反向代理，并使用 HTTPS 或可信私有网络保护 8768 端口的远程管理。`examples/` 中提供了一个最小 Caddy 配置示例。

## 连接 ChatGPT OAuth

将 `https://mcp.example.com/mcp` 填为服务器地址并选择 OAuth。服务器会发布授权服务器和受保护资源元数据。新客户端可以动态注册；随后 ChatGPT 打开授权页面，由主机所有者输入所有者令牌并批准所需权限范围。服务器使用授权码加 PKCE 流程，并签发支持离线访问的轮换刷新令牌。

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

- 自动生成的所有者令牌拥有全部权限范围；可以在受限的密钥存储中添加其他细粒度令牌。
- 密钥保存在 `~/.secure-host-mcp/secrets.json`；POSIX 系统要求权限为 `0600`。请备份并保护此文件。
- 审计日志会有意以明文记录完整命令及 stdout/stderr。日志按日期和大小轮换，并在数据目录中保留 30 天。
- MCP 与管理端默认监听全部网络接口。每个管理 API 请求都必须携带所有者 Bearer 令牌，写操作还必须携带页面 CSRF 令牌。
- 公网 HTTP 不提供加密：鉴权可以控制访问权限，但无法阻止 Bearer 令牌、OAuth 授权码或管理流量被网络窃听。应优先使用 HTTPS 或可信 VPN。
- 工具注解会要求兼容客户端在破坏性操作前进行确认，但主机端无法证明客户端确实向用户显示了确认界面。

## 配置

设置 `SECURE_HOST_MCP_HOME` 可以更改数据目录。将 `config.example.json` 中需要的字段复制到自动生成的 `config.json`，然后重启服务。配置与密钥均采用原子写入。

如需仅本机访问，请在配置中明确将 `mcp.host` 和 `admin.host` 都设置为 `127.0.0.1`。升级时会保留已有配置，不会悄悄把旧安装改为公网监听。为兼容旧脚本，仍接受 `setup --allow-lan-http` 参数；新安装已经默认允许远程管理。

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

`package.json` 是唯一版本来源。更新版本并合并后，推送完全匹配的标签（例如 `v0.1.0`）。GitHub Actions 会测试并打包两个平台、生成校验和与 Release Notes、发布 GitHub Release，并把同一版本发布到 npm。预发行版本使用 npm 的 `next` 标签，正式版本使用 `latest`。

npm 发布任务使用 GitHub OIDC Trusted Publishing，不需要在仓库 Secrets 中保存长期 npm 令牌。手动运行工作流时默认只做构建验证，除非明确开启发布，否则不会产生公开版本。
