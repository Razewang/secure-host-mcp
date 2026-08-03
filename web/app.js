(function () {
"use strict";

/* State — in-memory only, no localStorage */
var bootstrap = JSON.parse(document.getElementById("admin-bootstrap").textContent);
var adminToken = "";
var csrfToken = bootstrap.csrfToken;
var statusData = null;
var tokensData = [];
var logsData = null;
var currentLogContent = "";
var logViewRequestId = 0;
var pendingDialogAction = null;
var locale = navigator.language && navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";

var SCOPES = bootstrap.scopes;
var SCOPE_LABELS = {
  "system.read": "scopeSystemRead",
  "command.run": "scopeCommandRun",
  "command.elevate": "scopeCommandElevate",
  "workspace.read": "scopeWorkspaceRead",
  "workspace.write": "scopeWorkspaceWrite",
  "tunnel.read": "scopeTunnelRead",
  "tunnel.manage": "scopeTunnelManage",
  "admin.manage": "scopeAdminManage"
};
var TEXT = {
  zh: {
    authPrompt: "输入管理员令牌以访问控制面板", httpWarning: "请确保通过 HTTPS 或受信网络访问。HTTP 明文传输无法防止令牌被截获。", adminToken: "管理员令牌",
    connect: "连接", connecting: "验证中…", connected: "已连接", theme: "切换外观", disconnect: "断开连接", overview: "概览", tokens: "令牌", tunnels: "隧道", configuration: "配置",
    systemOverview: "系统概览", overviewDescription: "服务器运行状态与资源监控", loadingStatus: "正在加载系统状态…", tunnelStatus: "隧道状态",
    tokenManagement: "令牌管理", tokenDescription: "创建和管理 API 访问令牌及其权限范围", createNewToken: "创建新令牌", tokenName: "令牌名称",
    tokenNameExample: "例如：CI/CD 部署令牌", scopes: "权限范围", createToken: "创建令牌", existingTokens: "已有令牌", refresh: "刷新",
    loadingTokens: "正在加载令牌列表…", noTokens: "暂无令牌，创建第一个令牌以开始使用", tunnelControl: "隧道控制",
    tunnelDescription: "管理 frpc 和 Cloudflare 隧道的启停状态", serviceConfiguration: "服务配置", configurationDescription: "当前 MCP 服务与管理面板的运行配置",
    runtimeConfiguration: "运行配置", notLoaded: "尚未加载", confirmAction: "确认操作", confirmPrompt: "确定要执行此操作吗？", cancel: "取消", confirm: "确认",
    tokenRequired: "请输入管理员令牌", authFailed: "认证失败，请检查令牌", unauthorized: "认证失败：令牌无效或已过期", originRejected: "请求被拒绝：来源验证失败",
    rateLimited: "请求过于频繁，请稍后再试", requestFailed: "请求失败", hostname: "主机名", architecture: "系统架构", uptime: "运行时间", sinceStartup: "自上次启动",
    cpuCores: "CPU 核心", memory: "内存", available: "可用 {value}", runtimeVersion: "运行时版本", activeJobs: "后台任务", activeTerminals: "PTY 终端", runtimeHistory: "运行记录", activeNow: "当前运行", retainedSummaries: "保留摘要", noTunnelInfo: "无隧道信息", notInstalled: "未安装", running: "运行中", stopped: "已停止",
    scopeSystemRead: "系统读取", scopeCommandRun: "执行命令", scopeCommandElevate: "提权执行", scopeWorkspaceRead: "代码工作区读取", scopeWorkspaceWrite: "代码工作区修改", scopeTunnelRead: "隧道读取", scopeTunnelManage: "隧道管理", scopeAdminManage: "管理权限",
    adminManaged: "管理员令牌由 tokens.json 管理", delete: "删除", createdOn: "创建于 {date}", administrator: "管理员", connectionToken: "连接令牌", atLeastOneScope: "请至少选择一个权限范围",
    tokenCreated: "令牌创建成功", newTokenOnce: "新令牌（仅显示一次，请妥善保存）", agentToken: "Agent token", deleteToken: "删除令牌",
    deleteConfirm: "确定要删除令牌「{label}」吗？此操作不可撤销，使用该令牌的服务将立即失去访问权限。", tokenDeleted: "令牌已删除",
    frpcDescription: "通过 FRP 内网穿透服务暴露本地 MCP 端口，适用于无公网 IP 的环境。", cloudflareDescription: "通过 Cloudflare 零信任隧道安全暴露服务，自带 HTTPS 加密与 DDoS 防护。",
    version: "版本：{value}", start: "启动", stop: "停止", systemService: "由系统服务运行", tokenSystemService: "由系统服务以 Token 模式运行", externallyManaged: "此隧道由操作系统管理，请通过系统服务进行启停。", tunnelChanged: "{kind} 隧道已{action}", started: "启动", stoppedAction: "停止", daysHours: "{days} 天 {hours} 小时",
    hoursMinutes: "{hours} 小时 {minutes} 分", minutes: "{minutes} 分钟",
    logs: "日志", auditLogs: "审计日志", logsDescription: "命令执行与管理操作的审计记录", logLocation: "日志文件位置", logFiles: "日志文件",
    loadingLogs: "正在加载日志列表…", noLogs: "暂无审计日志记录", view: "查看", close: "关闭", modifiedOn: "更新于 {date}",
    logTruncated: "文件较大，仅显示末尾部分内容。完整日志请在上方目录中查看对应文件。",
    logEntry: "记录", logTime: "时间", logAction: "操作", logResult: "结果", logSucceeded: "成功", logFailed: "失败",
    logPrincipal: "操作者", logCorrelation: "关联 ID", logCommand: "命令", logStdout: "标准输出", logStderr: "错误输出",
    logMetadata: "元数据", logAdditionalFields: "其他字段", logRawEntry: "无法解析的原始记录", logLocalTime: "本地：{value}",
    filePaths: "文件位置", configFile: "配置文件", dataDirectory: "数据目录", auditDirectory: "审计日志目录",
    domainWarningText: "OIDC 鉴权需要公网域名：请在配置文件 {path} 中将 publicBaseUrl 设置为 frp 或 Cloudflare 隧道对应的域名（例如 https://mcp.example.com）。未配置时对外颁发的 OAuth/OIDC 元数据将指向本机地址，外部客户端无法完成鉴权。",
    mcpExample: "MCP 连接示例", copy: "复制", copied: "已复制到剪贴板", copyFailed: "复制失败，请手动选择复制",
    mcpExampleDescription: "免 OIDC 鉴权的连接方式：MCP 客户端通过 Authorization 请求头使用连接令牌直接接入 /mcp 端点。将示例中的 {placeholder} 替换为上方创建的真实连接令牌即可使用。",
    mcpExampleUrlNote: "尚未配置 publicBaseUrl，示例中的外网链接为占位域名。请先在配置文件中设置真实域名，再将该配置交给 MCP 客户端使用。"
  },
  en: {
    authPrompt: "Enter the administrator token to access the control panel", httpWarning: "Use HTTPS or a trusted network. Plain HTTP cannot prevent token interception.", adminToken: "Administrator token",
    connect: "Connect", connecting: "Verifying…", connected: "Connected", theme: "Toggle appearance", disconnect: "Disconnect", overview: "Overview", tokens: "Tokens", tunnels: "Tunnels", configuration: "Configuration",
    systemOverview: "System overview", overviewDescription: "Server health and resource usage", loadingStatus: "Loading system status…", tunnelStatus: "Tunnel status",
    tokenManagement: "Token management", tokenDescription: "Create and manage scoped API access tokens", createNewToken: "Create token", tokenName: "Token name",
    tokenNameExample: "Example: CI/CD deployment token", scopes: "Scopes", createToken: "Create token", existingTokens: "Existing tokens", refresh: "Refresh",
    loadingTokens: "Loading tokens…", noTokens: "No connection tokens yet", tunnelControl: "Tunnel control",
    tunnelDescription: "Start and stop frpc and Cloudflare tunnels", serviceConfiguration: "Service configuration", configurationDescription: "Current MCP and administration runtime configuration",
    runtimeConfiguration: "Runtime configuration", notLoaded: "Not loaded", confirmAction: "Confirm action", confirmPrompt: "Are you sure you want to continue?", cancel: "Cancel", confirm: "Confirm",
    tokenRequired: "Enter the administrator token", authFailed: "Authentication failed; check the token", unauthorized: "Authentication failed: invalid or expired token", originRejected: "Request rejected: origin validation failed",
    rateLimited: "Too many requests; try again shortly", requestFailed: "Request failed", hostname: "Hostname", architecture: "Architecture", uptime: "Uptime", sinceStartup: "Since last start",
    cpuCores: "CPU cores", memory: "Memory", available: "{value} available", runtimeVersion: "Runtime version", activeJobs: "Background jobs", activeTerminals: "PTY terminals", runtimeHistory: "Runtime records", activeNow: "Currently running", retainedSummaries: "Retained summaries", noTunnelInfo: "No tunnel information", notInstalled: "Not installed", running: "Running", stopped: "Stopped",
    scopeSystemRead: "Read system", scopeCommandRun: "Run commands", scopeCommandElevate: "Elevated commands", scopeWorkspaceRead: "Read coding workspace", scopeWorkspaceWrite: "Modify coding workspace", scopeTunnelRead: "Read tunnels", scopeTunnelManage: "Manage tunnels", scopeAdminManage: "Administration",
    adminManaged: "Administrator token is managed in tokens.json", delete: "Delete", createdOn: "Created {date}", administrator: "Administrator", connectionToken: "Connection token", atLeastOneScope: "Select at least one scope",
    tokenCreated: "Token created", newTokenOnce: "New token (shown once; save it now)", agentToken: "Agent token", deleteToken: "Delete token",
    deleteConfirm: "Delete token “{label}”? This cannot be undone and clients using it will immediately lose access.", tokenDeleted: "Token deleted",
    frpcDescription: "Expose the local MCP port through an FRP service when the host has no public IP.", cloudflareDescription: "Expose the service through a Cloudflare Zero Trust tunnel with HTTPS and DDoS protection.",
    version: "Version: {value}", start: "Start", stop: "Stop", systemService: "Running as a system service", tokenSystemService: "Running as a token-managed system service", externallyManaged: "This tunnel is managed by the operating system. Start or stop it through the system service.", tunnelChanged: "{kind} tunnel {action}", started: "started", stoppedAction: "stopped", daysHours: "{days}d {hours}h",
    hoursMinutes: "{hours}h {minutes}m", minutes: "{minutes}m",
    logs: "Logs", auditLogs: "Audit logs", logsDescription: "Audit records of command execution and administration actions", logLocation: "Log file location", logFiles: "Log files",
    loadingLogs: "Loading log files…", noLogs: "No audit log records yet", view: "View", close: "Close", modifiedOn: "Updated {date}",
    logTruncated: "Large file: only the tail is shown. Open the file from the directory above for the full log.",
    logEntry: "Entry", logTime: "Time", logAction: "Action", logResult: "Result", logSucceeded: "Succeeded", logFailed: "Failed",
    logPrincipal: "Principal", logCorrelation: "Correlation ID", logCommand: "Command", logStdout: "Standard output", logStderr: "Error output",
    logMetadata: "Metadata", logAdditionalFields: "Additional fields", logRawEntry: "Unparsed raw entry", logLocalTime: "Local: {value}",
    filePaths: "File locations", configFile: "Configuration file", dataDirectory: "Data directory", auditDirectory: "Audit log directory",
    domainWarningText: "OIDC authentication requires a public domain: set publicBaseUrl in {path} to the domain served by your frp or Cloudflare tunnel (e.g. https://mcp.example.com). Without it the published OAuth/OIDC metadata points at the local address and external clients cannot authenticate.",
    mcpExample: "MCP connection example", copy: "Copy", copied: "Copied to clipboard", copyFailed: "Copy failed; select and copy manually",
    mcpExampleDescription: "Connect without OIDC: MCP clients attach a connection token via the Authorization header to reach the /mcp endpoint directly. Replace {placeholder} in the example with a real connection token created above.",
    mcpExampleUrlNote: "publicBaseUrl is not configured, so the public URL in this example is a placeholder domain. Set your real domain in the configuration file before handing this config to an MCP client."
  }
};

function tr(key, values) {
  var message = TEXT[locale][key] || TEXT.en[key] || key;
  Object.keys(values || {}).forEach(function(name) { message = message.replace("{" + name + "}", values[name]); });
  return message;
}

function applyLocale() {
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach(function(element) { element.textContent = tr(element.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(function(element) { element.placeholder = tr(element.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-i18n-title]").forEach(function(element) { element.title = tr(element.dataset.i18nTitle); });
  document.getElementById("languageToggle").textContent = locale === "zh" ? "EN" : "中文";
  document.getElementById("mcpExampleDesc").textContent = tr("mcpExampleDescription", { placeholder: MCP_TOKEN_PLACEHOLDER });
}

/* Theme */
function toggleTheme() {
  var html = document.documentElement;
  var isDark = html.getAttribute("data-theme") === "dark";
  html.setAttribute("data-theme", isDark ? "light" : "dark");
  var icon = document.getElementById("themeIcon");
  if (isDark) {
    icon.innerHTML = '<circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>';
  } else {
    icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  }
}

/* Auth */
function connect() {
  var token = document.getElementById("tokenInput").value.trim();
  if (!token) { document.getElementById("authError").textContent = tr("tokenRequired"); return; }
  adminToken = token;
  document.getElementById("authError").textContent = "";
  document.getElementById("connectBtn").textContent = tr("connecting");
  document.getElementById("connectBtn").disabled = true;
  apiFetch("/api/status").then(function(data) {
    statusData = data;
    document.getElementById("authGate").style.display = "none";
    document.getElementById("app").classList.add("active");
    renderOverview();
    loadTokens();
    renderTunnels();
    renderConfig();
    renderDomainWarning();
    renderMcpExample();
    loadLogs();
  }).catch(function(err) {
    adminToken = "";
    document.getElementById("authError").textContent = err.message || tr("authFailed");
  }).finally(function() {
    document.getElementById("connectBtn").textContent = tr("connect");
    document.getElementById("connectBtn").disabled = false;
  });
}

function disconnect() {
  logViewRequestId += 1;
  adminToken = "";
  statusData = null;
  tokensData = [];
  logsData = null;
  currentLogContent = "";
  document.getElementById("logViewerPanel").style.display = "none";
  document.getElementById("app").classList.remove("active");
  document.getElementById("authGate").style.display = "flex";
  document.getElementById("tokenInput").value = "";
}

/* API */
function apiFetch(path, opts) {
  opts = opts || {};
  var headers = { "Authorization": "Bearer " + adminToken, "Content-Type": "application/json" };
  if (opts.method && opts.method !== "GET") { headers["X-CSRF-Token"] = csrfToken; }
  return fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
    .then(function(res) {
      if (res.status === 401) throw new Error(tr("unauthorized"));
      if (res.status === 403) throw new Error(tr("originRejected"));
      if (res.status === 429) throw new Error(tr("rateLimited"));
      if (res.status === 204) return null;
      if (!res.ok) return res.json().then(function(d) { throw new Error(d.message || tr("requestFailed") + " (" + res.status + ")"); });
      return res.json();
    });
}

/* Navigation */
function switchSection(name) {
  document.querySelectorAll(".section").forEach(function(s) { s.classList.remove("active"); });
  document.getElementById("sec-" + name).classList.add("active");
  document.querySelectorAll(".nav-item").forEach(function(n) { n.classList.toggle("active", n.dataset.section === name); });
  document.querySelectorAll(".mobile-nav button").forEach(function(n) { n.classList.toggle("active", n.dataset.section === name); });
}

/* Overview */
function renderOverview() {
  if (!statusData) return;
  var sys = statusData.system || {};
  var runtime = statusData.runtime || {};
  var jobs = runtime.jobs || [];
  var terminals = runtime.terminals || [];
  var cards = [
    { label: tr("hostname"), value: sys.hostname || "—", sub: sys.platform || "" },
    { label: tr("architecture"), value: sys.arch || "—", sub: sys.platform ? sys.platform + (sys.release ? " " + sys.release : "") : "" },
    { label: tr("uptime"), value: formatUptime(sys.uptime), sub: tr("sinceStartup") },
    { label: tr("cpuCores"), value: String(sys.cpus || "—"), sub: sys.cpuModel || "" },
    { label: tr("memory"), value: formatBytes(sys.totalMemory), sub: tr("available", { value: formatBytes(sys.freeMemory) }) },
    { label: "Node.js", value: sys.node || "—", sub: tr("runtimeVersion") },
    { label: tr("activeJobs"), value: String(jobs.filter(function(item) { return item.status === "running"; }).length), sub: tr("activeNow") },
    { label: tr("activeTerminals"), value: String(terminals.filter(function(item) { return item.status === "running"; }).length), sub: tr("activeNow") },
    { label: tr("runtimeHistory"), value: String(jobs.length + terminals.length), sub: tr("retainedSummaries") }
  ];
  var html = "";
  cards.forEach(function(c) {
    html += '<div class="stat-card"><div class="label">' + esc(c.label) + '</div><div class="value">' + esc(c.value) + '</div><div class="sub">' + esc(c.sub) + '</div></div>';
  });
  document.getElementById("sysCards").innerHTML = html;
  document.getElementById("overviewLoading").style.display = "none";
  document.getElementById("overviewContent").style.display = "block";

  /* Tunnel summary */
  var tunnels = statusData.tunnels || {};
  var tHtml = "";
  var kinds = Object.keys(tunnels);
  if (kinds.length === 0) { tHtml = '<p style="color:var(--muted);font-size:13px">' + tr("noTunnelInfo") + '</p>'; }
  kinds.forEach(function(k) {
    var t = tunnels[k];
    var installed = Boolean(t && t.installed);
    var lifecycle = tunnelLifecycle(t);
    var running = lifecycle.state === "running";
    var statusText = !installed ? tr("notInstalled") : (running ? tr("running") : tr("stopped"));
    tHtml += '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)"><span style="font-size:14px;font-weight:500">' + esc(k) + '</span><span class="tunnel-status ' + (running ? "running" : "stopped") + '">' + statusText + '</span></div>';
  });
  document.getElementById("tunnelSummary").innerHTML = tHtml;
}

/* Tokens */
function loadTokens() {
  document.getElementById("tokensLoading").style.display = "flex";
  document.getElementById("tokenList").style.display = "none";
  document.getElementById("tokensEmpty").style.display = "none";
  apiFetch("/api/tokens").then(function(data) {
    tokensData = data || [];
    document.getElementById("tokenCount").textContent = tokensData.length;
    renderTokenList();
  }).catch(function(err) {
    showToast(err.message, "error");
  }).finally(function() {
    document.getElementById("tokensLoading").style.display = "none";
  });
}

function renderTokenList() {
  var list = document.getElementById("tokenList");
  if (tokensData.length === 0) {
    list.style.display = "none";
    document.getElementById("tokensEmpty").style.display = "block";
    return;
  }
  document.getElementById("tokensEmpty").style.display = "none";
  list.style.display = "block";
  var html = "";
  tokensData.forEach(function(t) {
    var scopes = (t.scopes || []).map(function(s) { return '<span class="scope-tag">' + esc(SCOPE_LABELS[s] ? tr(SCOPE_LABELS[s]) : s) + '</span>'; }).join("");
    var action = !t.revocable
      ? '<span class="token-managed">' + tr("adminManaged") + '</span>'
      : '<button class="btn btn-danger btn-sm token-delete" data-token-id="' + esc(t.id) + '" data-token-label="' + esc(t.label || t.id) + '">' + tr("delete") + '</button>';
    html += '<li class="token-item"><div class="token-info"><div class="token-label">' + esc(t.label || t.id) + '</div><div class="token-meta"><span>ID: ' + esc(t.id) + '</span>' + (t.createdAt ? '<span>' + tr("createdOn", { date: new Date(t.createdAt).toLocaleDateString(locale === "zh" ? "zh-CN" : "en") }) + '</span>' : '') + '<span>' + esc(t.role === "admin" ? tr("administrator") : tr("connectionToken")) + '</span></div><div class="token-scopes">' + scopes + '</div></div>' + action + '</li>';
  });
  list.innerHTML = html;
  list.querySelectorAll(".token-delete").forEach(function(button) {
    button.addEventListener("click", function() { confirmDeleteToken(button.dataset.tokenId, button.dataset.tokenLabel); });
  });
}

function renderScopes() {
  var grid = document.getElementById("scopesGrid");
  var html = "";
  SCOPES.forEach(function(s) {
    html += '<label class="scope-checkbox checked" data-scope="' + s + '"><input type="checkbox" checked><span class="scope-check"><svg viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6l3 3 5-5"/></svg></span>' + esc(SCOPE_LABELS[s] ? tr(SCOPE_LABELS[s]) : s) + '</label>';
  });
  grid.innerHTML = html;
  grid.querySelectorAll(".scope-checkbox input").forEach(function(input) {
    input.addEventListener("change", function() { input.closest(".scope-checkbox").classList.toggle("checked", input.checked); });
  });
}

function createToken() {
  var label = document.getElementById("tokenLabel").value.trim() || tr("agentToken");
  var scopes = [];
  document.querySelectorAll("#scopesGrid .scope-checkbox").forEach(function(el) {
    if (el.querySelector("input").checked) scopes.push(el.dataset.scope);
  });
  if (scopes.length === 0) { showToast(tr("atLeastOneScope"), "error"); return; }
  apiFetch("/api/tokens", { method: "POST", body: { label: label, scopes: scopes } }).then(function(data) {
    showToast(tr("tokenCreated"), "success");
    document.getElementById("tokenLabel").value = "";
    if (data && data.token) {
      document.getElementById("newTokenResult").innerHTML = '<div class="new-token-result"><div class="label">' + tr("newTokenOnce") + '</div><code>' + esc(data.token) + '</code></div>';
    } else {
      document.getElementById("newTokenResult").innerHTML = "";
    }
    loadTokens();
  }).catch(function(err) { showToast(err.message, "error"); });
}

function confirmDeleteToken(id, label) {
  document.getElementById("dialogTitle").textContent = tr("deleteToken");
  document.getElementById("dialogMsg").textContent = tr("deleteConfirm", { label: label });
  document.getElementById("dialogOverlay").style.display = "flex";
  pendingDialogAction = function() {
    apiFetch("/api/tokens/" + encodeURIComponent(id), { method: "DELETE" }).then(function() {
      showToast(tr("tokenDeleted"), "success");
      loadTokens();
    }).catch(function(err) { showToast(err.message, "error"); });
  };
}

function dialogAction() { if (pendingDialogAction) pendingDialogAction(); closeDialog(); }
function closeDialog() { document.getElementById("dialogOverlay").style.display = "none"; pendingDialogAction = null; }

/* Tunnels */
function renderTunnels() {
  var tunnels = (statusData && statusData.tunnels) || {};
  var kinds = [
    { key: "frpc", name: "FRP Client", desc: tr("frpcDescription") },
    { key: "cloudflared", name: "Cloudflare Tunnel", desc: tr("cloudflareDescription") }
  ];
  var html = "";
  kinds.forEach(function(k) {
    var info = tunnels[k.key] || {};
    var installed = Boolean(info.installed);
    var lifecycle = tunnelLifecycle(info);
    var running = lifecycle.state === "running";
    var external = running && lifecycle.control === "external";
    var statusText = !installed ? tr("notInstalled") : (running ? tr("running") : tr("stopped"));
    var management = external ? '<br><span class="tunnel-management">' + tr(lifecycle.tokenManaged ? "tokenSystemService" : "systemService") + '</span><br><span class="tunnel-management-note">' + tr("externallyManaged") + '</span>' : "";
    html += '<div class="tunnel-card">' +
      '<div class="tunnel-card-header"><span class="tunnel-name"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' + k.name + '</span><span class="tunnel-status ' + (running ? "running" : "stopped") + '" id="tstatus-' + k.key + '">' + statusText + '</span></div>' +
      '<p class="tunnel-desc">' + k.desc + (info.version ? '<br>' + tr("version", { value: esc(info.version) }) : '') + management + '</p>' +
      '<div class="tunnel-actions"><button class="btn btn-success btn-sm tunnel-action" id="tstart-' + k.key + '" data-kind="' + k.key + '" data-action="start" ' + (running || !installed ? "disabled style=\"opacity:0.4;cursor:default\"" : "") + '>' + tr("start") + '</button><button class="btn btn-danger btn-sm tunnel-action" id="tstop-' + k.key + '" data-kind="' + k.key + '" data-action="stop" ' + (!(running && lifecycle.control === "managed") ? "disabled style=\"opacity:0.4;cursor:default\"" : "") + '>' + tr("stop") + '</button></div></div>';
  });
  var grid = document.getElementById("tunnelGrid");
  grid.innerHTML = html;
  grid.querySelectorAll(".tunnel-action").forEach(function(button) {
    button.addEventListener("click", function() { tunnelAction(button.dataset.kind, button.dataset.action); });
  });
}

function tunnelLifecycle(info) {
  if (info && info.lifecycle && (info.lifecycle.state === "running" || info.lifecycle.state === "stopped")) return info.lifecycle;
  return info && info.managedRunning ? { state: "running", control: "managed", pid: info.pid } : { state: "stopped" };
}

function tunnelAction(kind, action) {
  var startBtn = document.getElementById("tstart-" + kind);
  var stopBtn = document.getElementById("tstop-" + kind);
  if (startBtn) startBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = true;
  apiFetch("/api/tunnels/" + kind + "/" + action, { method: "POST" }).then(function() {
    showToast(tr("tunnelChanged", { kind: kind, action: action === "start" ? tr("started") : tr("stoppedAction") }), "success");
    return apiFetch("/api/status");
  }).then(function(data) {
    statusData = data;
    renderOverview();
    renderTunnels();
    renderConfig();
    renderDomainWarning();
    renderMcpExample();
  }).catch(function(err) {
    showToast(err.message, "error");
    renderTunnels();
  });
}

/* Config */
function renderConfig() {
  if (!statusData || !statusData.config) return;
  document.getElementById("configBlock").textContent = JSON.stringify(statusData.config, null, 2);
  var paths = statusData.paths || {};
  document.getElementById("configFilePath").textContent = paths.configFile || "—";
  document.getElementById("dataDirPath").textContent = paths.dataDir || "—";
  document.getElementById("auditDirPath").textContent = paths.auditDirectory || "—";
}

/* MCP connection example */
var MCP_TOKEN_PLACEHOLDER = "<REPLACE_WITH_CONNECTION_TOKEN>";

function mcpExampleConfig() {
  var base = statusData && statusData.config && statusData.config.publicBaseUrl;
  var url = (base ? String(base).replace(/\/+$/, "") : "https://your-domain.example.com") + "/mcp";
  return JSON.stringify({
    mcpServers: {
      "secure-host-mcp": {
        type: "http",
        url: url,
        headers: { "Authorization": "Bearer " + MCP_TOKEN_PLACEHOLDER }
      }
    }
  }, null, 2);
}

function renderMcpExample() {
  if (!statusData) return;
  document.getElementById("mcpExampleBlock").textContent = mcpExampleConfig();
  var missing = !(statusData.config && statusData.config.publicBaseUrl);
  document.getElementById("mcpExampleUrlNote").style.display = missing ? "flex" : "none";
  if (missing) document.getElementById("mcpExampleUrlNoteText").textContent = tr("mcpExampleUrlNote");
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise(function(resolve, reject) {
    var area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { if (document.execCommand("copy")) resolve(); else reject(new Error("copy rejected")); }
    catch (error) { reject(error); }
    finally { area.remove(); }
  });
}

function copyMcpExample() {
  copyText(document.getElementById("mcpExampleBlock").textContent)
    .then(function() { showToast(tr("copied"), "success"); })
    .catch(function() { showToast(tr("copyFailed"), "error"); });
}

/* Domain / OIDC warning */
function renderDomainWarning() {
  if (!statusData || !statusData.config) return;
  var missing = !statusData.config.publicBaseUrl;
  var text = missing ? tr("domainWarningText", { path: (statusData.paths && statusData.paths.configFile) || "config.json" }) : "";
  [["domainWarning", "domainWarningText"], ["configDomainWarning", "configDomainWarningText"]].forEach(function(pair) {
    var banner = document.getElementById(pair[0]);
    if (!banner) return;
    banner.style.display = missing ? "flex" : "none";
    document.getElementById(pair[1]).textContent = text;
  });
}

/* Logs */
function loadLogs() {
  document.getElementById("logsLoading").style.display = "flex";
  document.getElementById("logFileList").style.display = "none";
  document.getElementById("logsEmpty").style.display = "none";
  apiFetch("/api/logs").then(function(data) {
    logsData = data || { directory: "", files: [] };
    document.getElementById("logDirectory").textContent = logsData.directory || "—";
    renderLogFileList();
  }).catch(function(err) {
    showToast(err.message, "error");
  }).finally(function() {
    document.getElementById("logsLoading").style.display = "none";
  });
}

function renderLogFileList() {
  if (!logsData) return;
  var list = document.getElementById("logFileList");
  var files = logsData.files || [];
  if (files.length === 0) {
    list.style.display = "none";
    document.getElementById("logsEmpty").style.display = "block";
    return;
  }
  document.getElementById("logsEmpty").style.display = "none";
  list.style.display = "block";
  var html = "";
  files.forEach(function(f) {
    html += '<li class="log-file-item"><div class="log-file-info"><span class="log-file-name">' + esc(f.name) + '</span><span class="log-file-meta">' + formatBytes(f.size) + ' · ' + tr("modifiedOn", { date: new Date(f.modifiedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en") }) + '</span></div><button class="btn btn-ghost btn-sm log-view" data-log-name="' + esc(f.name) + '">' + tr("view") + '</button></li>';
  });
  list.innerHTML = html;
  list.querySelectorAll(".log-view").forEach(function(button) {
    button.addEventListener("click", function() { viewLog(button.dataset.logName); });
  });
}

function viewLog(name) {
  var requestId = ++logViewRequestId;
  apiFetch("/api/logs/" + encodeURIComponent(name)).then(function(data) {
    if (requestId !== logViewRequestId) return;
    document.getElementById("logViewerTitle").textContent = data.name;
    document.getElementById("logTruncatedNote").style.display = data.truncated ? "block" : "none";
    currentLogContent = data.content || "";
    document.getElementById("logContent").textContent = formatLogContent(currentLogContent);
    document.getElementById("logViewerPanel").style.display = "block";
  }).catch(function(err) {
    if (requestId === logViewRequestId) showToast(err.message, "error");
  });
}

function formatLogContent(content) {
  var lines = String(content || "").split(/\r?\n/).filter(function(line) { return line.trim(); });
  if (!lines.length) return "";
  return lines.map(function(line, index) {
    try {
      var entry = JSON.parse(line);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("not an object");
      return formatLogEntry(entry, index);
    } catch {
      return "# " + (index + 1) + " · " + tr("logRawEntry") + "\n\n" + line;
    }
  }).join("\n\n" + "─".repeat(72) + "\n\n");
}

function formatLogEntry(entry, index) {
  var lines = ["# " + (index + 1) + " · " + tr("logEntry")];
  appendLogField(lines, tr("logTime"), formatLogTimestamp(entry.timestamp), false);
  appendLogField(lines, tr("logAction"), entry.action, false);
  if (typeof entry.success === "boolean") appendLogField(lines, tr("logResult"), entry.success ? tr("logSucceeded") : tr("logFailed"), false);
  appendLogField(lines, tr("logPrincipal"), entry.principalId, false);
  appendLogField(lines, tr("logCorrelation"), entry.correlationId, false);
  appendLogField(lines, tr("logCommand"), entry.command, true);
  appendLogField(lines, tr("logStdout"), entry.stdout, true);
  appendLogField(lines, tr("logStderr"), entry.stderr, true);
  appendLogField(lines, tr("logMetadata"), entry.metadata, true);

  var known = ["timestamp", "action", "success", "principalId", "correlationId", "command", "stdout", "stderr", "metadata"];
  var additional = {};
  Object.keys(entry).forEach(function(key) {
    if (!known.includes(key)) additional[key] = entry[key];
  });
  if (Object.keys(additional).length) appendLogField(lines, tr("logAdditionalFields"), additional, true);
  return lines.join("\n");
}

function appendLogField(lines, label, value, block) {
  if (value === undefined || value === null || value === "") return;
  var formatted = formatLogValue(value);
  if (block || formatted.includes("\n")) lines.push("", label + ":", quoteLogBlock(formatted));
  else lines.push(label + ": " + formatted);
}

function quoteLogBlock(value) {
  return value.split(/[\n\u2028\u2029]/).map(function(line) { return "│ " + line; }).join("\n");
}

function formatLogValue(value) {
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function formatLogTimestamp(value) {
  if (!value) return "";
  var exact = String(value);
  var date = new Date(value);
  if (Number.isNaN(date.getTime())) return exact;
  var local = date.toLocaleString(locale === "zh" ? "zh-CN" : "en");
  return exact + " · " + tr("logLocalTime", { value: local });
}

/* Utilities */
function esc(s) { var d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return "—";
  var d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return tr("daysHours", { days: d, hours: h });
  if (h > 0) return tr("hoursMinutes", { hours: h, minutes: m });
  return tr("minutes", { minutes: m });
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "—";
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + " MB";
  return (bytes / 1024).toFixed(0) + " KB";
}

function showToast(msg, type) {
  var container = document.getElementById("toasts");
  var toast = document.createElement("div");
  toast.className = "toast " + (type || "");
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(function() { toast.style.opacity = "0"; toast.style.transform = "translateX(20px)"; toast.style.transition = "all 0.3s"; setTimeout(function() { toast.remove(); }, 300); }, 3500);
}

/* Init */
document.getElementById("tokenInput").addEventListener("keydown", function(e) { if (e.key === "Enter") connect(); });
document.getElementById("connectBtn").addEventListener("click", connect);
document.getElementById("themeToggle").addEventListener("click", toggleTheme);
document.getElementById("disconnectBtn").addEventListener("click", disconnect);
document.getElementById("createTokenBtn").addEventListener("click", createToken);
document.getElementById("refreshTokensBtn").addEventListener("click", loadTokens);
document.getElementById("refreshLogsBtn").addEventListener("click", loadLogs);
document.getElementById("copyMcpExampleBtn").addEventListener("click", copyMcpExample);
document.getElementById("closeLogBtn").addEventListener("click", function() {
  logViewRequestId += 1;
  document.getElementById("logViewerPanel").style.display = "none";
  currentLogContent = "";
});
document.getElementById("dialogCancel").addEventListener("click", closeDialog);
document.getElementById("dialogConfirm").addEventListener("click", dialogAction);
document.getElementById("languageToggle").addEventListener("click", function() {
  locale = locale === "zh" ? "en" : "zh";
  applyLocale();
  renderScopes();
  if (statusData) { renderOverview(); renderTunnels(); renderDomainWarning(); renderMcpExample(); }
  if (tokensData.length) renderTokenList();
  if (logsData) renderLogFileList();
  if (currentLogContent) document.getElementById("logContent").textContent = formatLogContent(currentLogContent);
});
document.querySelectorAll("[data-section]").forEach(function(button) {
  button.addEventListener("click", function() { switchSection(button.dataset.section); });
});
applyLocale();
renderScopes();
})();
