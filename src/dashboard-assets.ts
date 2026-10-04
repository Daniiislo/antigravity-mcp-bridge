/**
 * Local Read-Only Dashboard embedded HTML/CSS/JS assets for Antigravity MCP Bridge.
 *
 * Invariants:
 * - Pure Node.js built-in, zero external assets, fonts, or CDNs.
 * - Strict CSP and no-store security posture.
 * - Read-only: no mutation buttons, no arbitrary filesystem access.
 * - Safe DOM text APIs only: never assign untrusted content via innerHTML.
 * - Dense and responsive layout optimized for Codex side panel or browser tabs.
 */

export function getDashboardHtml(token: string): string {
  // Safe serialization of the token string into inline script
  const safeToken = JSON.stringify(token);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Antigravity MCP Bridge Dashboard</title>
  <style>
    :root {
      --bg-base: #10121a;
      --bg-surface: #181a26;
      --bg-panel: #202336;
      --bg-hover: #292d45;
      --bg-selected: #2d3352;
      --border-subtle: #2d324d;
      --border-strong: #3f466b;
      --text-main: #f0f2ff;
      --text-muted: #959bb8;
      --text-dim: #646a8c;
      --accent: #5b8bf7;
      --accent-dim: #3354a8;
      --status-queued: #e5a50a;
      --status-running: #4e80ee;
      --status-succeeded: #2ec27e;
      --status-failed: #f75b68;
      --status-canceled: #7b809a;
      --badge-bg: #262a42;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-base);
      color: var(--text-main);
      font-family: var(--font-sans);
      font-size: 13px;
      line-height: 1.45;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      -webkit-font-smoothing: antialiased;
    }

    /* Header */
    header {
      background-color: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      padding: 8px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      gap: 10px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .brand-title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.2px;
      color: var(--text-main);
    }

    .pill-readonly {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      background: var(--bg-panel);
      color: var(--text-muted);
      border: 1px solid var(--border-subtle);
      padding: 2px 6px;
      border-radius: 4px;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .header-stats {
      font-size: 12px;
      color: var(--text-muted);
    }

    .header-stats strong {
      color: var(--text-main);
    }

    .conn-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      background: var(--bg-panel);
      border: 1px solid var(--border-subtle);
    }

    .conn-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
    }

    .conn-live { color: var(--status-succeeded); }
    .conn-reconnecting { color: var(--status-queued); }
    .conn-polling { color: var(--accent); }
    .conn-disconnected { color: var(--status-failed); }

    /* Main Container */
    .app-body {
      display: flex;
      flex: 1;
      height: calc(100vh - 45px);
      overflow: hidden;
    }

    /* Left Sidebar: Filters + Job list */
    .sidebar {
      width: 340px;
      min-width: 280px;
      max-width: 420px;
      background: var(--bg-surface);
      border-right: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }

    .filter-panel {
      padding: 10px;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: var(--bg-surface);
    }

    .filter-search {
      width: 100%;
      background: var(--bg-panel);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      color: var(--text-main);
      padding: 5px 8px;
      font-size: 12px;
      outline: none;
    }
    .filter-search:focus {
      border-color: var(--accent);
    }

    .filter-row {
      display: flex;
      gap: 6px;
    }

    .filter-select {
      flex: 1;
      background: var(--bg-panel);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      color: var(--text-main);
      padding: 4px 6px;
      font-size: 11px;
      outline: none;
      cursor: pointer;
    }
    .filter-select:focus {
      border-color: var(--accent);
    }

    .job-list {
      flex: 1;
      overflow-y: auto;
      list-style: none;
    }

    .job-item {
      padding: 9px 12px;
      border-bottom: 1px solid var(--border-subtle);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 3px;
      transition: background 0.1s ease;
      border-left: 3px solid transparent;
    }

    .job-item:hover {
      background: var(--bg-hover);
    }

    .job-item.selected {
      background: var(--bg-selected);
      border-left-color: var(--accent);
    }

    .job-item-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }

    .job-item-id {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      color: var(--text-main);
    }

    .job-item-role {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--badge-bg);
      color: var(--text-muted);
    }

    .job-item-brief {
      font-size: 12px;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .job-item-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-dim);
    }

    .status-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 1px 6px;
      border-radius: 10px;
      letter-spacing: 0.3px;
    }

    .status-badge.succeeded { background: rgba(46, 194, 126, 0.15); color: var(--status-succeeded); border: 1px solid rgba(46, 194, 126, 0.3); }
    .status-badge.failed { background: rgba(247, 91, 104, 0.15); color: var(--status-failed); border: 1px solid rgba(247, 91, 104, 0.3); }
    .status-badge.running { background: rgba(78, 128, 238, 0.15); color: var(--status-running); border: 1px solid rgba(78, 128, 238, 0.3); }
    .status-badge.queued { background: rgba(229, 165, 10, 0.15); color: var(--status-queued); border: 1px solid rgba(229, 165, 10, 0.3); }
    .status-badge.canceled { background: rgba(123, 128, 154, 0.15); color: var(--status-canceled); border: 1px solid rgba(123, 128, 154, 0.3); }

    /* Right Main Panel: Detail view */
    .main-view {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg-base);
    }

    .no-selection {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-dim);
      font-size: 14px;
      padding: 20px;
      text-align: center;
    }

    .detail-view {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .detail-header {
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
    }

    .detail-header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .detail-title {
      font-family: var(--font-mono);
      font-size: 14px;
      font-weight: 700;
      color: var(--text-main);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .detail-meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px 18px;
      font-size: 11.5px;
      color: var(--text-muted);
    }

    .detail-meta-item strong {
      color: var(--text-main);
    }

    .denied-alert {
      background: rgba(247, 91, 104, 0.12);
      border: 1px solid rgba(247, 91, 104, 0.35);
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 11.5px;
      color: var(--status-failed);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Tabs Bar */
    .tabs-bar {
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      padding: 0 16px;
      gap: 4px;
      flex-shrink: 0;
    }

    .tab-btn {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-muted);
      font-family: var(--font-sans);
      font-size: 12px;
      font-weight: 600;
      padding: 8px 12px;
      cursor: pointer;
      transition: all 0.1s ease;
    }

    .tab-btn:hover {
      color: var(--text-main);
    }

    .tab-btn.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }

    /* Tab Content Viewport */
    .tab-viewport {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }

    /* Conversation View Cards */
    .convo-container {
      display: flex;
      flex-direction: column;
      gap: 14px;
      max-width: 900px;
    }

    .msg-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .msg-header {
      background: var(--bg-panel);
      padding: 6px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 11px;
    }

    .msg-author {
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .msg-author.user {
      color: #92b6ff;
    }

    .msg-author.assistant {
      color: #3dd68c;
    }

    .msg-time {
      color: var(--text-dim);
    }

    .msg-content {
      padding: 12px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text-main);
    }

    .msg-card.error-card {
      border-color: rgba(247, 91, 104, 0.4);
    }

    .msg-card.error-card .msg-header {
      background: rgba(247, 91, 104, 0.12);
    }

    .badge-trunc {
      display: inline-block;
      margin-top: 6px;
      background: rgba(229, 165, 10, 0.15);
      color: var(--status-queued);
      border: 1px solid rgba(229, 165, 10, 0.3);
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 3px;
    }

    /* Activity View */
    .activity-timeline {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: 900px;
    }

    .activity-item {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 5px;
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
    }

    .activity-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
    }

    .activity-type {
      font-weight: 700;
      text-transform: uppercase;
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--bg-panel);
      color: var(--text-muted);
    }

    .activity-time {
      color: var(--text-dim);
      font-size: 11px;
    }

    .activity-body {
      font-family: var(--font-mono);
      font-size: 11.5px;
      color: var(--text-main);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .stderr-box {
      background: #190e12;
      border: 1px solid rgba(247, 91, 104, 0.3);
      color: #ff9da6;
      border-radius: 4px;
      padding: 8px;
      font-family: var(--font-mono);
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 250px;
      overflow-y: auto;
    }

    /* Raw Events View */
    .raw-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: 1000px;
    }

    .raw-item {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      overflow: hidden;
    }

    .raw-header {
      background: var(--bg-panel);
      padding: 4px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-muted);
    }

    .raw-code {
      padding: 8px 10px;
      font-family: var(--font-mono);
      font-size: 11px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text-main);
      background: var(--bg-base);
      max-height: 300px;
      overflow-y: auto;
    }

    /* Responsive adjustments for Codex side panel */
    @media (max-width: 700px) {
      .app-body {
        flex-direction: column;
      }
      .sidebar {
        width: 100%;
        max-width: 100%;
        height: 240px;
        border-right: none;
        border-bottom: 1px solid var(--border-subtle);
      }
      .main-view {
        flex: 1;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span class="brand-title">Antigravity Bridge</span>
      <span class="pill-readonly">READ-ONLY</span>
    </div>
    <div class="header-right">
      <div class="header-stats">
        Workers: <strong id="stat-workers">0</strong> &bull; Jobs: <strong id="stat-jobs">0</strong>
      </div>
      <div id="conn-badge" class="conn-badge conn-disconnected">
        <span class="conn-dot"></span>
        <span id="conn-status-text">Connecting...</span>
      </div>
    </div>
  </header>

  <div class="app-body">
    <!-- Left Sidebar: Filters and Jobs -->
    <aside class="sidebar">
      <div class="filter-panel">
        <input id="filter-search" type="text" class="filter-search" placeholder="Search brief or job ID..." />
        <div class="filter-row">
          <select id="filter-role" class="filter-select">
            <option value="">All Roles</option>
            <option value="implementer">implementer</option>
            <option value="tester">tester</option>
          </select>
          <select id="filter-status" class="filter-select">
            <option value="">All Statuses</option>
            <option value="queued">queued</option>
            <option value="running">running</option>
            <option value="succeeded">succeeded</option>
            <option value="failed">failed</option>
            <option value="canceled">canceled</option>
          </select>
        </div>
        <select id="filter-worker" class="filter-select">
          <option value="">All Workers</option>
        </select>
      </div>
      <div id="job-list" class="job-list"></div>
    </aside>

    <!-- Right Main Panel: Selected Job Detail -->
    <main class="main-view">
      <div id="no-selection" class="no-selection">
        Select a job from the list to inspect details.
      </div>
      <div id="detail-view" class="detail-view" style="display: none;">
        <div class="detail-header">
          <div class="detail-header-top">
            <div class="detail-title">
              <span id="detail-job-id"></span>
              <span id="detail-status-badge" class="status-badge"></span>
            </div>
            <div id="detail-time-meta" class="detail-meta-item"></div>
          </div>
          <div class="detail-meta-row">
            <div class="detail-meta-item">Worker: <strong id="detail-worker-id"></strong></div>
            <div class="detail-meta-item">Role: <strong id="detail-role"></strong></div>
            <div class="detail-meta-item">Workspace: <strong id="detail-workspace"></strong></div>
            <div class="detail-meta-item" id="detail-usage-container" style="display:none;">
              Usage: <strong id="detail-usage"></strong>
            </div>
          </div>
          <div id="detail-denied-container" class="denied-alert" style="display: none;">
            <strong>Denied Actions:</strong> <span id="detail-denied-list"></span>
          </div>
        </div>

        <nav class="tabs-bar">
          <button id="tab-btn-conversation" class="tab-btn active">Conversation</button>
          <button id="tab-btn-activity" class="tab-btn">Activity</button>
          <button id="tab-btn-raw" class="tab-btn">Raw Events</button>
        </nav>

        <div id="tab-viewport" class="tab-viewport">
          <div id="view-conversation" class="convo-container"></div>
          <div id="view-activity" class="activity-timeline" style="display: none;"></div>
          <div id="view-raw" class="raw-list" style="display: none;"></div>
        </div>
      </div>
    </main>
  </div>

  <script>
    (function() {
      "use strict";

      const TOKEN = ${safeToken};
      const BASE_API = "/" + TOKEN + "/api";

      // Application State
      let workersMap = new Map();
      let jobsMap = new Map();
      let selectedJobId = null;
      let selectedJobData = null;
      let activeTab = "conversation";
      let lastCursor = 0;
      let eventSource = null;
      let pollTimer = null;
      let isNearBottom = true;

      // Safe DOM Helper - NEVER uses innerHTML
      function make(tag, className, textContent) {
        const elem = document.createElement(tag);
        if (className) elem.className = className;
        if (textContent !== undefined && textContent !== null) {
          elem.textContent = String(textContent);
        }
        return elem;
      }

      function clearNode(node) {
        while (node.firstChild) {
          node.removeChild(node.firstChild);
        }
      }

      function formatTime(iso) {
        if (!iso) return "";
        try {
          const d = new Date(iso);
          return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch {
          return iso;
        }
      }

      // Connection Status UI
      const connBadge = document.getElementById("conn-badge");
      const connStatusText = document.getElementById("conn-status-text");

      function updateConnectionStatus(state) {
        connBadge.className = "conn-badge";
        if (state === "live") {
          connBadge.classList.add("conn-live");
          connStatusText.textContent = "Live";
        } else if (state === "reconnecting") {
          connBadge.classList.add("conn-reconnecting");
          connStatusText.textContent = "Reconnecting...";
        } else if (state === "polling") {
          connBadge.classList.add("conn-polling");
          connStatusText.textContent = "Polling";
        } else {
          connBadge.classList.add("conn-disconnected");
          connStatusText.textContent = "Disconnected";
        }
      }

      // Filter elements
      const filterSearch = document.getElementById("filter-search");
      const filterRole = document.getElementById("filter-role");
      const filterStatus = document.getElementById("filter-status");
      const filterWorker = document.getElementById("filter-worker");
      const jobListContainer = document.getElementById("job-list");

      filterSearch.addEventListener("input", renderJobList);
      filterRole.addEventListener("change", renderJobList);
      filterStatus.addEventListener("change", renderJobList);
      filterWorker.addEventListener("change", renderJobList);

      function updateWorkerOptions() {
        const selected = filterWorker.value;
        clearNode(filterWorker);
        const optAll = make("option", null, "All Workers");
        optAll.value = "";
        filterWorker.appendChild(optAll);

        const ids = Array.from(workersMap.keys()).sort();
        for (const wid of ids) {
          const opt = make("option", null, wid);
          opt.value = wid;
          if (wid === selected) opt.selected = true;
          filterWorker.appendChild(opt);
        }
      }

      function renderJobList() {
        clearNode(jobListContainer);

        const q = filterSearch.value.trim().toLowerCase();
        const role = filterRole.value;
        const status = filterStatus.value;
        const workerId = filterWorker.value;

        const allJobs = Array.from(jobsMap.values());
        allJobs.sort(function(a, b) {
          const tA = new Date(a.created_at || 0).getTime();
          const tB = new Date(b.created_at || 0).getTime();
          return tB - tA;
        });

        document.getElementById("stat-jobs").textContent = String(allJobs.length);
        document.getElementById("stat-workers").textContent = String(workersMap.size);

        for (const job of allJobs) {
          if (role && job.role !== role) continue;
          if (status && job.status !== status) continue;
          if (workerId && job.worker_id !== workerId) continue;
          if (q) {
            const matchesId = (job.job_id || "").toLowerCase().includes(q);
            const matchesBrief = (job.brief || "").toLowerCase().includes(q);
            if (!matchesId && !matchesBrief) continue;
          }

          const item = make("div", "job-item" + (job.job_id === selectedJobId ? " selected" : ""));
          item.addEventListener("click", function() {
            selectJob(job.job_id);
          });

          const rowTop = make("div", "job-item-top");
          rowTop.appendChild(make("span", "job-item-id", job.job_id));

          const sBadge = make("span", "status-badge " + (job.status || "queued"), job.status || "queued");
          rowTop.appendChild(sBadge);
          item.appendChild(rowTop);

          const brief = make("div", "job-item-brief", job.brief || "(no brief)");
          item.appendChild(brief);

          const rowMeta = make("div", "job-item-meta");
          const roleBadge = make("span", "job-item-role", job.role || "worker");
          rowMeta.appendChild(roleBadge);
          rowMeta.appendChild(make("span", null, formatTime(job.created_at)));
          item.appendChild(rowMeta);

          jobListContainer.appendChild(item);
        }
      }

      // Tab Switcher
      const tabBtnConversation = document.getElementById("tab-btn-conversation");
      const tabBtnActivity = document.getElementById("tab-btn-activity");
      const tabBtnRaw = document.getElementById("tab-btn-raw");

      const viewConversation = document.getElementById("view-conversation");
      const viewActivity = document.getElementById("view-activity");
      const viewRaw = document.getElementById("view-raw");
      const tabViewport = document.getElementById("tab-viewport");

      function switchTab(newTab) {
        activeTab = newTab;
        tabBtnConversation.classList.toggle("active", newTab === "conversation");
        tabBtnActivity.classList.toggle("active", newTab === "activity");
        tabBtnRaw.classList.toggle("active", newTab === "raw");

        viewConversation.style.display = newTab === "conversation" ? "flex" : "none";
        viewActivity.style.display = newTab === "activity" ? "flex" : "none";
        viewRaw.style.display = newTab === "raw" ? "flex" : "none";

        if (isNearBottom) {
          tabViewport.scrollTop = tabViewport.scrollHeight;
        }
      }

      tabBtnConversation.addEventListener("click", function() { switchTab("conversation"); });
      tabBtnActivity.addEventListener("click", function() { switchTab("activity"); });
      tabBtnRaw.addEventListener("click", function() { switchTab("raw"); });

      tabViewport.addEventListener("scroll", function() {
        const threshold = 60;
        isNearBottom = (tabViewport.scrollHeight - tabViewport.scrollTop - tabViewport.clientHeight) <= threshold;
      });

      // Job Detail Selection
      async function selectJob(jobId) {
        selectedJobId = jobId;
        renderJobList();

        try {
          const res = await fetch(BASE_API + "/jobs/" + encodeURIComponent(jobId));
          if (!res.ok) {
            throw new Error("HTTP " + res.status);
          }
          const job = await res.json();
          selectedJobData = job;
          renderJobDetail(job);

          // Update URL without full reload
          const params = new URLSearchParams(window.location.search);
          params.set("job_id", jobId);
          window.history.replaceState(null, "", "?" + params.toString());
        } catch (err) {
          console.error("Failed to load job detail", err);
        }
      }

      function renderJobDetail(job) {
        document.getElementById("no-selection").style.display = "none";
        document.getElementById("detail-view").style.display = "flex";

        document.getElementById("detail-job-id").textContent = job.job_id;
        const sBadge = document.getElementById("detail-status-badge");
        sBadge.className = "status-badge " + (job.status || "queued");
        sBadge.textContent = job.status || "queued";

        let timeStr = "Created: " + formatTime(job.created_at);
        if (job.duration_seconds !== undefined) {
          timeStr += " (" + job.duration_seconds.toFixed(2) + "s)";
        }
        document.getElementById("detail-time-meta").textContent = timeStr;

        document.getElementById("detail-worker-id").textContent = job.worker_id || "-";
        document.getElementById("detail-role").textContent = job.role || "-";
        document.getElementById("detail-workspace").textContent = job.workspace || "-";

        const usageElem = document.getElementById("detail-usage");
        const usageContainer = document.getElementById("detail-usage-container");
        if (job.usage) {
          usageContainer.style.display = "block";
          usageElem.textContent = "in=" + (job.usage.input_tokens || 0) +
            " out=" + (job.usage.output_tokens || 0) +
            " total=" + (job.usage.total_tokens || 0);
        } else {
          usageContainer.style.display = "none";
        }

        const deniedContainer = document.getElementById("detail-denied-container");
        const deniedList = document.getElementById("detail-denied-list");
        if (job.denied_actions && job.denied_actions.length > 0) {
          deniedContainer.style.display = "flex";
          deniedList.textContent = job.denied_actions.join(", ");
        } else {
          deniedContainer.style.display = "none";
        }

        renderConversationTab(job);
        renderActivityTab(job);
        renderRawEventsTab(job);

        if (isNearBottom) {
          tabViewport.scrollTop = tabViewport.scrollHeight;
        }
      }

      function renderConversationTab(job) {
        clearNode(viewConversation);

        // Turn 1: Codex -> Antigravity (Prompt)
        const userCard = make("div", "msg-card");
        const userHeader = make("div", "msg-header");
        const userAuthor = make("span", "msg-author user", "Codex \u2192 Antigravity");
        userHeader.appendChild(userAuthor);
        userHeader.appendChild(make("span", "msg-time", formatTime(job.created_at)));
        userCard.appendChild(userHeader);

        const promptText = job.effective_prompt || job.brief || "(empty prompt)";
        const userBody = make("pre", "msg-content", promptText);
        if (promptText.includes("... [truncated]")) {
          userBody.appendChild(make("span", "badge-trunc", "[TRUNCATED]"));
        }
        userCard.appendChild(userBody);
        viewConversation.appendChild(userCard);

        // Turn 2: Antigravity -> Codex (Assistant Response / Error)
        if (job.status === "running" && (!job.result && !job.error)) {
          // Check if intermediate text deltas exist
          let streamedText = "";
          if (Array.isArray(job.step_events)) {
            for (const step of job.step_events) {
              if (step.text_delta) streamedText += step.text_delta;
            }
          }
          if (streamedText) {
            const assistantCard = make("div", "msg-card");
            const aHeader = make("div", "msg-header");
            aHeader.appendChild(make("span", "msg-author assistant", "Antigravity \u2192 Codex (Streaming...)"));
            assistantCard.appendChild(aHeader);
            const aBody = make("pre", "msg-content", streamedText);
            assistantCard.appendChild(aBody);
            viewConversation.appendChild(assistantCard);
          }
        } else if (job.result || job.error || job.status === "succeeded" || job.status === "failed") {
          const isErr = job.status === "failed" || !!job.error;
          const assistantCard = make("div", "msg-card" + (isErr ? " error-card" : ""));
          const aHeader = make("div", "msg-header");
          aHeader.appendChild(make("span", "msg-author assistant", "Antigravity \u2192 Codex"));
          aHeader.appendChild(make("span", "msg-time", formatTime(job.finished_at)));
          assistantCard.appendChild(aHeader);

          const respText = job.result || job.error || (isErr ? "Failed without explicit error" : "(empty response)");
          const aBody = make("pre", "msg-content", respText);
          if (respText.includes("... [truncated]")) {
            aBody.appendChild(make("span", "badge-trunc", "[TRUNCATED]"));
          }
          assistantCard.appendChild(aBody);
          viewConversation.appendChild(assistantCard);
        }
      }

      function renderActivityTab(job) {
        clearNode(viewActivity);

        // Lifecycle: Queued
        const queuedItem = make("div", "activity-item");
        const qH = make("div", "activity-header");
        qH.appendChild(make("span", "activity-type", "lifecycle"));
        qH.appendChild(make("span", "activity-time", formatTime(job.created_at)));
        queuedItem.appendChild(qH);
        queuedItem.appendChild(make("div", "activity-body", "Task queued in worker queue"));
        viewActivity.appendChild(queuedItem);

        // Started
        if (job.started_at) {
          const startedItem = make("div", "activity-item");
          const sH = make("div", "activity-header");
          sH.appendChild(make("span", "activity-type", "lifecycle"));
          sH.appendChild(make("span", "activity-time", formatTime(job.started_at)));
          startedItem.appendChild(sH);
          startedItem.appendChild(make("div", "activity-body", "Worker started execution"));
          viewActivity.appendChild(startedItem);
        }

        // Steps
        if (Array.isArray(job.step_events)) {
          for (let i = 0; i < job.step_events.length; i++) {
            const step = job.step_events[i];
            const sItem = make("div", "activity-item");
            const sH = make("div", "activity-header");
            const stepLabel = "step " + (step.step_index !== undefined ? step.step_index : (i + 1));
            sH.appendChild(make("span", "activity-type", stepLabel));
            if (step.timestamp) {
              sH.appendChild(make("span", "activity-time", formatTime(step.timestamp)));
            }
            sItem.appendChild(sH);

            let desc = "";
            if (step.step_type) desc += "[" + step.step_type + "] ";
            if (step.state) desc += "state=" + step.state + " ";
            if (step.text_delta) desc += "\\n" + step.text_delta;
            if (step.tool_name) desc += "\\ntool=" + step.tool_name;
            if (step.command) desc += "\\ncommand=" + step.command;

            sItem.appendChild(make("div", "activity-body", desc.trim() || JSON.stringify(step)));
            viewActivity.appendChild(sItem);
          }
        }

        // Stderr events if present in events array
        if (Array.isArray(job.events)) {
          for (const ev of job.events) {
            if (ev.eventType === "stderr" && ev.data && ev.data.stderr) {
              const errItem = make("div", "activity-item");
              const errH = make("div", "activity-header");
              errH.appendChild(make("span", "activity-type", "stderr"));
              errH.appendChild(make("span", "activity-time", formatTime(ev.timestamp)));
              errItem.appendChild(errH);
              const errBox = make("pre", "stderr-box", ev.data.stderr);
              errItem.appendChild(errBox);
              viewActivity.appendChild(errItem);
            }
          }
        }

        // Denied Actions
        if (Array.isArray(job.denied_actions)) {
          for (const denied of job.denied_actions) {
            const dItem = make("div", "activity-item");
            const dH = make("div", "activity-header");
            dH.appendChild(make("span", "activity-type", "denial"));
            dItem.appendChild(dH);
            dItem.appendChild(make("div", "activity-body", "Action Denied: " + denied));
            viewActivity.appendChild(dItem);
          }
        }

        // Terminal status
        if (job.finished_at) {
          const finItem = make("div", "activity-item");
          const fH = make("div", "activity-header");
          fH.appendChild(make("span", "activity-type", "lifecycle"));
          fH.appendChild(make("span", "activity-time", formatTime(job.finished_at)));
          finItem.appendChild(fH);
          let summary = "Task finished with status: " + job.status;
          if (job.duration_seconds !== undefined) {
            summary += " in " + job.duration_seconds.toFixed(2) + "s";
          }
          if (job.usage) {
            summary += " (Tokens: " + job.usage.total_tokens + ")";
          }
          finItem.appendChild(make("div", "activity-body", summary));
          viewActivity.appendChild(finItem);
        }
      }

      function renderRawEventsTab(job) {
        clearNode(viewRaw);

        const events = job.events || [];
        if (events.length === 0) {
          viewRaw.appendChild(make("div", "no-selection", "No raw events available for this job."));
          return;
        }

        for (const evt of events) {
          const item = make("div", "raw-item");
          const hdr = make("div", "raw-header");
          hdr.appendChild(make("span", null, "#" + (evt.cursor || 0) + " \u2022 " + (evt.eventType || "event")));
          hdr.appendChild(make("span", null, formatTime(evt.timestamp)));
          item.appendChild(hdr);

          const pre = make("pre", "raw-code", JSON.stringify(evt.data || evt, null, 2));
          item.appendChild(pre);
          viewRaw.appendChild(item);
        }
      }

      // Incoming Event Processing
      function handleIncomingEvent(evt) {
        if (!evt) return;

        if (evt.eventType === "lifecycle") {
          const d = evt.data || {};
          if (d.lifecycle === "worker_created" && evt.workerId) {
            workersMap.set(evt.workerId, {
              workerId: evt.workerId,
              role: d.role,
              workspace: d.workspace,
              status: "idle"
            });
            updateWorkerOptions();
          }

          if (evt.jobId) {
            let j = jobsMap.get(evt.jobId);
            if (!j) {
              j = {
                job_id: evt.jobId,
                worker_id: evt.workerId,
                role: d.role || "implementer",
                status: "queued",
                brief: d.brief || "",
                created_at: evt.timestamp
              };
              jobsMap.set(evt.jobId, j);
            }

            if (d.lifecycle === "started") {
              j.status = "running";
              j.started_at = d.started_at || evt.timestamp;
            } else if (d.lifecycle === "succeeded") {
              j.status = "succeeded";
              j.finished_at = d.finished_at || evt.timestamp;
              j.result = d.response;
              j.duration_seconds = d.duration_seconds;
              j.usage = d.usage;
            } else if (d.lifecycle === "failed") {
              j.status = "failed";
              j.finished_at = d.finished_at || evt.timestamp;
              j.error = d.error;
            } else if (d.lifecycle === "canceled") {
              j.status = "canceled";
              j.finished_at = d.finished_at || evt.timestamp;
            }

            renderJobList();
          }
        }

        // If the event belongs to selected job, refresh its detail
        if (selectedJobId && evt.jobId === selectedJobId) {
          selectJob(selectedJobId);
        }
      }

      // Live SSE Connection
      function startSSE() {
        if (eventSource) {
          try { eventSource.close(); } catch {}
          eventSource = null;
        }

        updateConnectionStatus("reconnecting");
        const streamUrl = BASE_API + "/stream?after=" + encodeURIComponent(lastCursor);
        eventSource = new EventSource(streamUrl);

        eventSource.onopen = function() {
          updateConnectionStatus("live");
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        };

        eventSource.addEventListener("event", function(e) {
          try {
            const evt = JSON.parse(e.data);
            if (evt.cursor && evt.cursor > lastCursor) {
              lastCursor = evt.cursor;
            }
            handleIncomingEvent(evt);
          } catch (err) {
            console.error("SSE parse error", err);
          }
        });

        eventSource.onerror = function() {
          updateConnectionStatus("reconnecting");
          // EventSource will automatically retry connecting.
          // In addition, start backup polling if connection remains broken:
          if (!pollTimer) {
            startPolling();
          }
        };
      }

      // Polling Fallback
      function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(async function() {
          try {
            const res = await fetch(BASE_API + "/events?after=" + encodeURIComponent(lastCursor) + "&limit=100");
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();
            updateConnectionStatus("polling");
            if (Array.isArray(data.events)) {
              for (const ev of data.events) {
                if (ev.cursor && ev.cursor > lastCursor) {
                  lastCursor = ev.cursor;
                }
                handleIncomingEvent(ev);
              }
            }
          } catch {
            updateConnectionStatus("disconnected");
          }
        }, 2000);
      }

      // Initial Bootstrap
      async function init() {
        updateConnectionStatus("reconnecting");

        try {
          const res = await fetch(BASE_API + "/snapshot");
          if (!res.ok) throw new Error("Snapshot HTTP " + res.status);
          const snap = await res.json();

          if (Array.isArray(snap.workers)) {
            for (const w of snap.workers) {
              workersMap.set(w.workerId || w.worker_id, w);
            }
            updateWorkerOptions();
          }

          if (Array.isArray(snap.jobs)) {
            for (const j of snap.jobs) {
              jobsMap.set(j.job_id, j);
            }
          }

          if (typeof snap.latest_cursor === "number") {
            lastCursor = snap.latest_cursor;
          }

          // Check URL query parameters
          const params = new URLSearchParams(window.location.search);
          const qWorker = params.get("worker_id");
          const qJob = params.get("job_id");

          if (qWorker) {
            filterWorker.value = qWorker;
          }

          renderJobList();

          if (qJob && jobsMap.has(qJob)) {
            selectJob(qJob);
          } else if (jobsMap.size > 0 && !qJob) {
            // Auto select latest job
            const newest = Array.from(jobsMap.values())[0];
            if (newest) selectJob(newest.job_id);
          }

          startSSE();
        } catch (err) {
          console.error("Failed to load initial snapshot", err);
          updateConnectionStatus("disconnected");
          startPolling();
        }
      }

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
      } else {
        init();
      }
    })();
  </script>
</body>
</html>`;
}
