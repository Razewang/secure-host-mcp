import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables
} from "@modelcontextprotocol/ext-apps/app-with-deps";

const app = new App({ name: "Secure Host runtime status", version: "1.0.0" }, {});
const root = document.getElementById("app");

function text(value, fallback = "—") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function bytes(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = amount;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function escapeHtml(value) {
  return text(value, "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function statusBadge(status) {
  const safe = escapeHtml(status);
  return `<span class="badge badge-${safe}">${safe}</span>`;
}

function runtimeRows(items, emptyLabel) {
  if (!Array.isArray(items) || items.length === 0) return `<p class="empty">${emptyLabel}</p>`;
  return `<div class="runtime-list">${items.map((item) => `
    <div class="runtime-row">
      <div>
        <strong>${escapeHtml(item.kind === "terminal" ? "Terminal" : "Job")}</strong>
        <span class="mono">${escapeHtml(item.summary)}</span>
      </div>
      <div class="runtime-meta">${statusBadge(item.status)}<span>${escapeHtml(item.startedAt)}</span></div>
    </div>`).join("")}</div>`;
}

function render(snapshot) {
  if (!root) return;
  const host = snapshot?.host ?? {};
  const workspace = snapshot?.workspace;
  const git = workspace?.git;
  root.innerHTML = `
    <header>
      <div>
        <p class="eyebrow">Secure Host MCP</p>
        <h1>${escapeHtml(host.hostname ?? "Runtime status")}</h1>
      </div>
      <span class="badge badge-running">Online</span>
    </header>
    <section class="metrics">
      <article><span>CPU</span><strong>${escapeHtml(host.cpus)}</strong><small>${escapeHtml(host.cpuModel)}</small></article>
      <article><span>Free memory</span><strong>${bytes(host.freeMemory)}</strong><small>of ${bytes(host.totalMemory)}</small></article>
      <article><span>Platform</span><strong>${escapeHtml(host.platform)}</strong><small>${escapeHtml(host.arch)} · ${escapeHtml(host.node)}</small></article>
    </section>
    ${workspace ? `<section>
      <div class="section-title"><h2>Workspace</h2>${git?.dirty ? statusBadge("dirty") : statusBadge("clean")}</div>
      <p class="mono path">${escapeHtml(workspace.root)}</p>
      <dl><div><dt>Branch</dt><dd>${escapeHtml(git?.branch)}</dd></div><div><dt>HEAD</dt><dd class="mono">${escapeHtml(git?.head?.slice?.(0, 12))}</dd></div></dl>
    </section>` : ""}
    <section><div class="section-title"><h2>Terminals</h2><span>${Array.isArray(snapshot?.terminals) ? snapshot.terminals.length : 0}</span></div>${runtimeRows(snapshot?.terminals, "No visible terminal sessions")}</section>
    <section><div class="section-title"><h2>Jobs</h2><span>${Array.isArray(snapshot?.jobs) ? snapshot.jobs.length : 0}</span></div>${runtimeRows(snapshot?.jobs, "No visible background jobs")}</section>
    <footer>Snapshot generated ${escapeHtml(snapshot?.generatedAt)}</footer>`;
}

function applyHostContext(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

app.ontoolresult = (result) => render(result.structuredContent ?? {});
app.onhostcontextchanged = (context) => applyHostContext(context);

app.connect()
  .then(() => applyHostContext(app.getHostContext()))
  .catch((error) => {
    if (root) root.innerHTML = `<p class="error">Unable to connect the runtime status card: ${escapeHtml(error instanceof Error ? error.message : error)}</p>`;
  });
