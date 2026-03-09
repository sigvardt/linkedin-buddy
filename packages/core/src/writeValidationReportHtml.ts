import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  WriteValidationActionResult,
  WriteValidationReport
} from "./writeValidationShared.js";

const STATUS_LABELS: Record<WriteValidationActionResult["status"], string> = {
  cancelled: "Cancelled",
  fail: "Fail",
  pass: "Pass"
};

const RISK_LABELS: Record<WriteValidationActionResult["risk_class"], string> = {
  network: "Network",
  private: "Private",
  public: "Public"
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function formatDurationMs(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "0ms";
  }

  if (value < 1_000) {
    return `${Math.round(value)}ms`;
  }

  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1)}s`;
  }

  return `${Math.round(value / 1_000)}s`;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

function formatCountLabel(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildFileLink(filePath: string, label?: string): string {
  const href = escapeHtml(pathToFileURL(filePath).href);
  const text = escapeHtml(label ?? filePath);
  return `<a href="${href}"><code>${text}</code></a>`;
}

function resolveRunDir(report: WriteValidationReport): string {
  return path.dirname(report.audit_log_path);
}

function resolveArtifactPath(runDir: string, artifactPath: string): string {
  return path.isAbsolute(artifactPath) ? artifactPath : path.resolve(runDir, artifactPath);
}

function renderPathList(title: string, paths: readonly string[], runDir: string): string {
  if (paths.length === 0) {
    return "";
  }

  const items = paths.map((artifactPath) => {
    const resolvedPath = resolveArtifactPath(runDir, artifactPath);
    return `<li>${buildFileLink(resolvedPath, artifactPath)}</li>`;
  });

  return [
    '<section class="card-subsection">',
    `<h3>${escapeHtml(title)}</h3>`,
    `<ul class="path-list">${items.join("")}</ul>`,
    "</section>"
  ].join("");
}

function renderTextList(title: string, values: readonly string[]): string {
  if (values.length === 0) {
    return "";
  }

  const items = values.map((value) => `<li>${escapeHtml(value)}</li>`);
  return [
    '<section class="card-subsection">',
    `<h3>${escapeHtml(title)}</h3>`,
    `<ul class="text-list">${items.join("")}</ul>`,
    "</section>"
  ].join("");
}

function renderJsonDetails(title: string, value: unknown, open: boolean = false): string {
  return [
    `<details class="json-details"${open ? " open" : ""}>`,
    `<summary>${escapeHtml(title)}</summary>`,
    `<pre>${escapeHtml(formatJson(value))}</pre>`,
    "</details>"
  ].join("");
}

function renderActionCard(
  action: WriteValidationActionResult,
  index: number,
  totalActions: number,
  runDir: string
): string {
  const statusClass = `status-${action.status}`;
  const riskClass = `risk-${action.risk_class}`;
  const verificationLabel = action.verification?.verified === true ? "Verified" : "Unverified";
  const stateLabel =
    action.state_synced === null ? "State n/a" : action.state_synced ? "State ok" : "State mismatch";
  const warnings = action.warnings ?? [];
  const actionMeta = [
    `<span>${escapeHtml(`${index + 1}/${totalActions}`)}</span>`,
    `<span>${escapeHtml(formatDurationMs(action.duration_ms))}</span>`,
    `<span>${escapeHtml(verificationLabel)}</span>`,
    `<span>${escapeHtml(stateLabel)}</span>`,
    `<span>${escapeHtml(formatCountLabel(action.artifact_paths.length, "artifact"))}</span>`
  ];

  if (warnings.length > 0) {
    actionMeta.push(`<span>${escapeHtml(formatCountLabel(warnings.length, "warning"))}</span>`);
  }

  if (action.error_code) {
    actionMeta.push(`<span>${escapeHtml(action.error_code)}</span>`);
  }

  const verificationBlock = action.verification
    ? [
        '<section class="card-subsection">',
        "<h3>Verification</h3>",
        `<p>${escapeHtml(action.verification.message)}</p>`,
        `<p class="muted">Source: ${escapeHtml(action.verification.source)}</p>`,
        "</section>"
      ].join("")
    : "";

  const errorBlock = action.error_message
    ? [
        '<section class="card-subsection">',
        "<h3>Error</h3>",
        `<p>${escapeHtml(action.error_message)}</p>`,
        action.failure_stage
          ? `<p class="muted">Stage: ${escapeHtml(action.failure_stage)}</p>`
          : "",
        "</section>"
      ].join("")
    : "";

  return [
    `<article class="action-card ${statusClass}" data-action-card data-status="${escapeHtml(action.status)}" data-risk="${escapeHtml(action.risk_class)}">`,
    '<header class="action-header">',
    '<div class="action-badges">',
    `<span class="badge ${statusClass}">${escapeHtml(STATUS_LABELS[action.status])}</span>`,
    `<span class="badge ${riskClass}">${escapeHtml(RISK_LABELS[action.risk_class])}</span>`,
    "</div>",
    `<h2>${escapeHtml(action.action_type)}</h2>`,
    `<p class="action-summary">${escapeHtml(action.summary)}</p>`,
    `<div class="action-meta">${actionMeta.join("")}</div>`,
    "</header>",
    '<section class="card-subsection">',
    "<h3>Expected outcome</h3>",
    `<p>${escapeHtml(action.expected_outcome)}</p>`,
    "</section>",
    verificationBlock,
    errorBlock,
    renderTextList("Warnings", warnings),
    renderTextList("Cleanup guidance", action.cleanup_guidance),
    renderPathList("Artifacts", action.artifact_paths, runDir),
    renderPathList("Before screenshots", action.before_screenshot_paths, runDir),
    renderPathList("After screenshots", action.after_screenshot_paths, runDir),
    renderPathList("Confirm artifacts", action.confirm_artifacts, runDir),
    renderJsonDetails("Target preview", action.preview?.target ?? {}, false),
    renderJsonDetails("Outbound payload", action.preview?.outbound ?? {}, false),
    action.linkedin_response
      ? renderJsonDetails("LinkedIn response", action.linkedin_response, false)
      : "",
    action.error_details
      ? renderJsonDetails("Error details", action.error_details, false)
      : "",
    action.verification?.details
      ? renderJsonDetails("Verification details", action.verification.details, false)
      : "",
    "</article>"
  ].join("");
}

export function renderWriteValidationReportHtml(report: WriteValidationReport): string {
  const runDir = resolveRunDir(report);
  const htmlReportPath = report.html_report_path ?? path.join(path.dirname(report.report_path), "report.html");
  const reportLinks = [
    `<li>JSON report: ${buildFileLink(report.report_path)}</li>`,
    `<li>HTML report: ${buildFileLink(htmlReportPath)}</li>`,
    `<li>Audit log: ${buildFileLink(report.audit_log_path)}</li>`,
    `<li>Latest snapshot: ${buildFileLink(report.latest_report_path)}</li>`
  ];
  const outcomeLabel = STATUS_LABELS[report.outcome];
  const cleanupActionCount = report.actions.filter((action) => action.cleanup_guidance.length > 0).length;
  const totalArtifactCount = report.actions.reduce((count, action) => count + action.artifact_paths.length, 0);
  const actionCards = report.actions.map((action, index) => {
    return renderActionCard(action, index, report.actions.length, runDir);
  });

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtml(`Write validation — ${report.account.label}`)}</title>`,
    "  <style>",
    "    :root { color-scheme: light dark; --bg: #0b1020; --panel: #121a2b; --panel-alt: #172238; --text: #eef3ff; --muted: #a6b3cf; --border: rgba(255,255,255,0.12); --green: #3fb950; --yellow: #d29922; --red: #f85149; --blue: #58a6ff; }",
    "    * { box-sizing: border-box; }",
    "    body { margin: 0; font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: linear-gradient(180deg, #0b1020 0%, #10192f 100%); color: var(--text); }",
    "    a { color: var(--blue); }",
    "    code, pre { font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, monospace; }",
    "    .page { max-width: 1200px; margin: 0 auto; padding: 32px 20px 64px; }",
    "    .hero, .panel, .action-card { background: rgba(18, 26, 43, 0.94); border: 1px solid var(--border); border-radius: 16px; box-shadow: 0 20px 48px rgba(0,0,0,0.28); }",
    "    .hero { padding: 24px; margin-bottom: 20px; }",
    "    .hero-header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 16px; align-items: flex-start; }",
    "    .hero h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.2; }",
    "    .hero p { margin: 0; color: var(--muted); }",
    "    .hero-meta { display: grid; gap: 6px; justify-items: end; text-align: right; color: var(--muted); }",
    "    .badge { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 4px 10px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; font-size: 12px; }",
    "    .status-pass { background: rgba(63,185,80,0.18); color: #7ee787; }",
    "    .status-fail { background: rgba(248,81,73,0.18); color: #ff9b97; }",
    "    .status-cancelled { background: rgba(210,153,34,0.18); color: #f2cc60; }",
    "    .risk-private, .risk-network, .risk-public { background: rgba(88,166,255,0.14); color: #9cc8ff; }",
    "    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 20px 0; }",
    "    .summary-card { background: rgba(255,255,255,0.04); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }",
    "    .summary-card h2 { margin: 0; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }",
    "    .summary-card p { margin: 6px 0 0; font-size: 28px; font-weight: 700; }",
    "    .summary-card small { display: block; margin-top: 6px; color: var(--muted); }",
    "    .panel { padding: 20px; margin-bottom: 20px; }",
    "    .panel h2 { margin: 0 0 12px; font-size: 18px; }",
    "    .link-list, .path-list, .text-list { margin: 0; padding-left: 18px; }",
    "    .filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 18px; }",
    "    .filter-group { display: inline-flex; flex-wrap: wrap; gap: 8px; align-items: center; }",
    "    .filter-label { color: var(--muted); font-weight: 600; }",
    "    .filter-button { background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 999px; color: var(--text); cursor: pointer; padding: 8px 12px; }",
    "    .filter-button.is-active { border-color: rgba(88,166,255,0.7); background: rgba(88,166,255,0.18); }",
    "    .actions-header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; margin-bottom: 16px; align-items: center; }",
    "    .actions-grid { display: grid; gap: 16px; }",
    "    .action-card { padding: 20px; }",
    "    .action-header h2 { margin: 10px 0 6px; font-size: 22px; }",
    "    .action-summary { margin: 0 0 12px; color: var(--muted); }",
    "    .action-badges, .action-meta { display: flex; flex-wrap: wrap; gap: 8px; }",
    "    .action-meta span { background: rgba(255,255,255,0.04); border-radius: 999px; padding: 4px 10px; color: var(--muted); }",
    "    .card-subsection { margin-top: 14px; }",
    "    .card-subsection h3 { margin: 0 0 6px; font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }",
    "    .card-subsection p { margin: 0; }",
    "    .json-details { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 14px; }",
    "    .json-details summary { cursor: pointer; color: var(--blue); font-weight: 600; }",
    "    .json-details pre { margin: 10px 0 0; padding: 12px; border-radius: 12px; background: rgba(0,0,0,0.28); overflow: auto; white-space: pre-wrap; word-break: break-word; }",
    "    .muted { color: var(--muted); }",
    "    [hidden] { display: none !important; }",
    "    @media (max-width: 720px) { .hero-meta { justify-items: start; text-align: left; } .hero-header { flex-direction: column; } }",
    "  </style>",
    "</head>",
    "<body>",
    '  <main class="page">',
    '    <section class="hero">',
    '      <div class="hero-header">',
    '        <div>',
    `          <span class="badge status-${escapeHtml(report.outcome)}">${escapeHtml(outcomeLabel)}</span>`,
    `          <h1>${escapeHtml(report.account.label)}</h1>`,
    `          <p>${escapeHtml(report.summary)}</p>`,
    '        </div>',
    '        <div class="hero-meta">',
    `          <div>Account: <strong>${escapeHtml(report.account.id)}</strong> (${escapeHtml(report.account.designation)})</div>`,
    `          <div>Run: <code>${escapeHtml(report.run_id)}</code></div>`,
    `          <div>Started: ${escapeHtml(report.started_at)}</div>`,
    `          <div>Finished: ${escapeHtml(report.checked_at)}</div>`,
    '        </div>',
    '      </div>',
    '      <div class="summary-grid">',
    '        <div class="summary-card"><h2>Total actions</h2><p>' + escapeHtml(String(report.action_count)) + '</p><small>' + escapeHtml(formatCountLabel(cleanupActionCount, "action needs cleanup", "actions need cleanup")) + '</small></div>',
    '        <div class="summary-card"><h2>Passed</h2><p>' + escapeHtml(String(report.pass_count)) + '</p><small>' + escapeHtml(formatCountLabel(report.pass_count, "verified action")) + '</small></div>',
    '        <div class="summary-card"><h2>Failed</h2><p>' + escapeHtml(String(report.fail_count)) + '</p><small>' + escapeHtml(formatCountLabel(report.fail_count, "action needs review")) + '</small></div>',
    '        <div class="summary-card"><h2>Cancelled</h2><p>' + escapeHtml(String(report.cancelled_count)) + '</p><small>' + escapeHtml(formatCountLabel(report.cancelled_count, "action skipped")) + '</small></div>',
    '        <div class="summary-card"><h2>Total duration</h2><p>' + escapeHtml(formatDurationMs(report.duration_ms)) + '</p><small>' + escapeHtml(`Cooldown ${formatDurationMs(report.cooldown_ms)} between actions`) + '</small></div>',
    '        <div class="summary-card"><h2>Artifacts</h2><p>' + escapeHtml(String(totalArtifactCount)) + '</p><small>' + escapeHtml(formatCountLabel(totalArtifactCount, "artifact")) + '</small></div>',
    '      </div>',
    '    </section>',
    '    <section class="panel">',
    '      <h2>Reports</h2>',
    `      <p class="muted">${escapeHtml(report.warning)}</p>`,
    `      <ul class="link-list">${reportLinks.join("")}</ul>`,
    '    </section>',
    '    <section class="panel">',
    '      <div class="actions-header">',
    '        <div>',
    '          <h2>Actions</h2>',
    '          <p class="muted">Showing <span data-visible-count>0</span> of ' + escapeHtml(String(report.actions.length)) + ' actions.</p>',
    '        </div>',
    '        <div class="filters">',
    '          <div class="filter-group">',
    '            <span class="filter-label">Status</span>',
    '            <button class="filter-button is-active" type="button" data-filter-group="status" data-filter-value="all">All</button>',
    '            <button class="filter-button" type="button" data-filter-group="status" data-filter-value="pass">Pass</button>',
    '            <button class="filter-button" type="button" data-filter-group="status" data-filter-value="fail">Fail</button>',
    '            <button class="filter-button" type="button" data-filter-group="status" data-filter-value="cancelled">Cancelled</button>',
    '          </div>',
    '          <div class="filter-group">',
    '            <span class="filter-label">Risk</span>',
    '            <button class="filter-button is-active" type="button" data-filter-group="risk" data-filter-value="all">All</button>',
    '            <button class="filter-button" type="button" data-filter-group="risk" data-filter-value="private">Private</button>',
    '            <button class="filter-button" type="button" data-filter-group="risk" data-filter-value="network">Network</button>',
    '            <button class="filter-button" type="button" data-filter-group="risk" data-filter-value="public">Public</button>',
    '          </div>',
    '        </div>',
    '      </div>',
    `      <div class="actions-grid">${actionCards.join("")}</div>`,
    '    </section>',
    report.recommended_actions.length > 0
      ? [
          '    <section class="panel">',
          '      <h2>Recommended next steps</h2>',
          `      <ul class="text-list">${report.recommended_actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>`,
          '    </section>'
        ].join("\n")
      : "",
    '  </main>',
    '  <script>',
    '    (() => {',
    '      const state = { status: "all", risk: "all" };',
    '      const cards = Array.from(document.querySelectorAll("[data-action-card]"));',
    '      const visibleCount = document.querySelector("[data-visible-count]");',
    '      const buttons = Array.from(document.querySelectorAll("[data-filter-group]"));',
    '      const applyFilters = () => {',
    '        let visible = 0;',
    '        for (const card of cards) {',
    '          const status = card.getAttribute("data-status") || "all";',
    '          const risk = card.getAttribute("data-risk") || "all";',
    '          const matchesStatus = state.status === "all" || state.status === status;',
    '          const matchesRisk = state.risk === "all" || state.risk === risk;',
    '          const isVisible = matchesStatus && matchesRisk;',
    '          card.hidden = !isVisible;',
    '          if (isVisible) {',
    '            visible += 1;',
    '          }',
    '        }',
    '        if (visibleCount) {',
    '          visibleCount.textContent = String(visible);',
    '        }',
    '      };',
    '      const syncButtons = () => {',
    '        for (const button of buttons) {',
    '          const group = button.getAttribute("data-filter-group");',
    '          const value = button.getAttribute("data-filter-value");',
    '          const active = Boolean(group && value && state[group] === value);',
    '          button.classList.toggle("is-active", active);',
    '        }',
    '      };',
    '      for (const button of buttons) {',
    '        button.addEventListener("click", () => {',
    '          const group = button.getAttribute("data-filter-group");',
    '          const value = button.getAttribute("data-filter-value");',
    '          if (!group || !value) {',
    '            return;',
    '          }',
    '          state[group] = value;',
    '          syncButtons();',
    '          applyFilters();',
    '        });',
    '      }',
    '      syncButtons();',
    '      applyFilters();',
    '    })();',
    '  </script>',
    "</body>",
    "</html>"
  ].join("\n");
}
