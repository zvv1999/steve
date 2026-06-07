const state = {
  targets: [],
  runs: [],
  targetId: "codenext",
  run: null,
  plan: null,
  query: "",
  busy: false,
  advanced: false,
};

const $ = (id) => document.getElementById(id);

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setBusy(busy) {
  state.busy = busy;
  for (const button of document.querySelectorAll("button")) button.disabled = busy;
}

function riskClass(risk) {
  if (risk === "high") return "danger";
  if (risk === "medium") return "warn";
  return "good";
}

function healthBadge(label, health) {
  const cls = health?.ok ? "good" : "danger";
  return `<span class="badge ${cls}">${escapeHtml(label)}：${escapeHtml(health?.message || "未知")}</span>`;
}

function statusLabel(status) {
  return {
    planned: "待拆分",
    "worktree-ready": "工作树就绪",
    "context-ready": "上下文就绪",
    "handoff-ready": "等待 App 接管",
    "in-progress": "优化中",
    "codex-completed": "Codex 已完成",
    "needs-polish": "需要打磨",
    validating: "复验中",
    validated: "已复验",
    rejected: "已搁置",
  }[status] || status || "待拆分";
}

function latestAppSession(item) {
  return [...(item.codexSessions || [])].reverse().find((session) => session.mode === "app-handoff") || null;
}

function normalizedRecommendation(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["merge", "建议合并"].includes(raw)) return "merge";
  if (["needs-polish", "continue", "暂不合并", "继续优化"].includes(raw)) return "needs-polish";
  if (["human", "needs-human", "manual", "需要人工确认"].includes(raw)) return "needs-human";
  if (["reject", "abandon", "rejected", "搁置"].includes(raw)) return "reject";
  return "";
}

function qualityScore(item) {
  const score = Number(item.qualityScore ?? latestAppSession(item)?.qualityScore);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null;
}

function morningDecision(item) {
  const session = latestAppSession(item);
  const recommendation = normalizedRecommendation(item.mergeRecommendation || session?.recommendation);
  const score = qualityScore(item);
  const hasResult = Boolean(item.resultPath || session?.hasResult);
  const hasEvidence = Boolean((item.evidencePaths || session?.evidencePaths || []).length);
  if (item.status === "failed") return { label: "阻塞", cls: "danger", kind: "blocked" };
  if (recommendation === "merge" && score === 100 && hasResult && hasEvidence) return { label: "建议合并", cls: "good", kind: "merge" };
  if (recommendation === "needs-human") return { label: "人工确认", cls: "warn", kind: "human" };
  if (recommendation === "reject" || item.status === "rejected") return { label: "暂不合并", cls: "danger", kind: "reject" };
  if (recommendation === "needs-polish" || item.status === "needs-polish" || score != null) return { label: "继续优化", cls: "warn", kind: "continue" };
  return { label: "等待回收", cls: "", kind: "pending" };
}

function decisionCounts(items) {
  const counts = { merge: 0, continue: 0, human: 0, blocked: 0, pending: 0, reject: 0 };
  for (const item of items.filter((candidate) => (
    candidate.id !== "visual-quality-score"
      && (candidate.selected || candidate.codexSessions?.some((session) => session.mode === "app-handoff"))
  ))) {
    counts[morningDecision(item).kind] += 1;
  }
  return counts;
}

function isWorkerItem(item) {
  return item.id !== "visual-quality-score" && item.codexSessions?.some((session) => session.mode === "app-handoff");
}

function shortText(value, max = 118) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function executionLabel(item) {
  if (item.resultPath || latestAppSession(item)?.hasResult) return "已有交付报告";
  if (["worktree-ready", "context-ready", "handoff-ready", "in-progress", "codex-completed", "validated"].includes(item.status)) {
    return "隔离工作区已准备";
  }
  return "等待准备";
}

function renderInternalPaths(item) {
  if (!state.advanced) return "";
  return `
    <div class="path">
      内部工作区：${escapeHtml(item.worktreePath || "未创建")}<br>
      内部分支：${escapeHtml(item.branch || "未创建")}
    </div>
  `;
}

function agentStage(item) {
  const decision = morningDecision(item);
  if (decision.kind === "merge") return { label: "可合并", cls: "done" };
  if (decision.kind === "continue") return { label: "继续优化", cls: "warn" };
  if (decision.kind === "human") return { label: "待人工确认", cls: "warn" };
  if (decision.kind === "blocked" || decision.kind === "reject") return { label: decision.label, cls: "danger" };
  if (["handoff-ready", "context-ready", "in-progress"].includes(item.status)) return { label: statusLabel(item.status), cls: "active" };
  if (item.status === "codex-completed") return { label: "待总质检确认", cls: "warn" };
  return { label: decision.label, cls: "" };
}

function allNextWorkers(items) {
  const seen = new Set();
  const list = [];
  for (const item of items) {
    const next = item.nextWorkers || latestAppSession(item)?.nextWorkers || [];
    for (const worker of next) {
      const value = typeof worker === "string" ? worker : worker?.id || worker?.title;
      if (!value || seen.has(value)) continue;
      seen.add(value);
      list.push(value);
    }
  }
  return list;
}

function itemSubtitle(item) {
  return shortText(item.validationNotes || item.proposal || item.finding || "等待 worker 写入当前动作。", 124);
}

function miniPills(item) {
  const score = qualityScore(item);
  const decision = morningDecision(item);
  const hasResult = Boolean(item.resultPath || latestAppSession(item)?.hasResult);
  return [
    `<span class="mini-pill ${decision.cls || ""}">${escapeHtml(decision.label)}</span>`,
    score == null ? "" : `<span class="mini-pill ${score === 100 ? "good" : "warn"}">${escapeHtml(score)}/100</span>`,
    item.skill ? `<span class="mini-pill blue">${escapeHtml(item.skill)}</span>` : "",
    hasResult ? `<span class="mini-pill good">有报告</span>` : "",
  ].filter(Boolean).join("");
}

function laneCard(item) {
  const session = latestAppSession(item);
  return `
    <div class="lane-item">
      <strong>${escapeHtml(item.title)}</strong>
      ${escapeHtml(itemSubtitle(item))}
      <div class="mini">
        ${miniPills(item)}
        ${session?.resultPath ? `<span class="mini-pill">result.md</span>` : ""}
      </div>
    </div>
  `;
}

function renderFlow() {
  const root = $("flow");
  if (!root) return;
  if (!state.run) {
    root.innerHTML = `
      <div class="flow-head">
        <div>
          <h2>Agent 链路</h2>
          <p>Steve 还没有 run，生成计划后这里会显示 coordinator、worker 和总质检。</p>
        </div>
      </div>
    `;
    return;
  }
  const items = state.run.items || [];
  const workers = items.filter(isWorkerItem);
  const activeWorkers = workers.filter((item) => ["handoff-ready", "context-ready", "in-progress", "needs-polish"].includes(item.status));
  const mergeReady = workers.filter((item) => morningDecision(item).kind === "merge");
  const waitingQa = workers.filter((item) => item.status === "codex-completed" && morningDecision(item).kind !== "merge");
  const nextWorkers = allNextWorkers(items);
  const counts = decisionCounts(items);
  const qc = state.run.coordination?.qualityController || {};
  const qcActive = activeWorkers.length || waitingQa.length || nextWorkers.length || mergeReady.length;

  root.innerHTML = `
    <div class="flow-head">
      <div>
        <h2><span class="pulse-dot"></span>当前 Agent 工作看板</h2>
        <p>左边看谁正在做，中间看总质检怎么判，右边看下一批会继续做什么。</p>
        <div class="flow-status-line">
          <span class="badge good">可合并 ${escapeHtml(counts.merge)}</span>
          <span class="badge warn">正在/待接管 ${escapeHtml(activeWorkers.length)}</span>
          <span class="badge">总质检 ${escapeHtml(mergeReady.length || waitingQa.length ? "已回收" : "等待结果")}</span>
          <span class="badge">当前批次</span>
        </div>
      </div>
      <span class="badge ${qcActive ? "good" : "warn"}">${qc.neverIdle ? "持续演进中" : "质量门禁"}</span>
    </div>
    <div class="flow-grid">
      <div class="flow-node active">
        <div class="flow-node-title">
          <span>1. Steve 派发任务</span>
          <span class="badge good">已启动</span>
        </div>
        <small>把产品目标拆成 worker，并登记到当前 run。当前可见 worker：${escapeHtml(workers.length)} 个。</small>
        <div class="flow-arrow">生成上下文 → 分配给 worker</div>
      </div>
      <div class="flow-node ${activeWorkers.length ? "active" : "done"}">
        <div class="flow-node-title">
          <span>2. Codex worker 执行</span>
          <span class="badge ${activeWorkers.length ? "warn" : "good"}">${activeWorkers.length ? `${activeWorkers.length} 个正在工作` : "本批已交回"}</span>
        </div>
        <div class="agent-list">
          ${workers.filter((item) => state.advanced || item.status !== "rejected").map((item) => {
            const stage = agentStage(item);
            const score = qualityScore(item);
            return `
              <div class="agent-row">
                <div>
                  <h3>${escapeHtml(item.title)}</h3>
                  <p>${escapeHtml(itemSubtitle(item))}</p>
                </div>
                <span class="badge ${stage.cls}">${escapeHtml(stage.label)}</span>
                <div class="agent-meta">
                  <span class="badge">${escapeHtml(item.agent || "worker")}</span>
                  <span class="badge">${escapeHtml(item.skill || "skill")}</span>
                  ${score == null ? "" : `<span class="badge ${score === 100 ? "good" : "warn"}">${escapeHtml(score)}/100</span>`}
                  ${item.resultPath ? `<span class="badge good">result</span>` : ""}
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
      <div class="flow-node ${mergeReady.length ? "done" : "active"}">
        <div class="flow-node-title">
          <span>3. 总质检验收</span>
          <span class="badge ${mergeReady.length ? "good" : "warn"}">${mergeReady.length} 个可合并</span>
        </div>
        <small>复核报告、改动文件、测试、视觉证据和服务是否生效。worker 的自评只作为输入。</small>
        <div class="flow-arrow">通过 → 合并候选；不足 → 继续派生</div>
      </div>
    </div>
    <div class="flow-lanes">
      <div class="lane active">
        <h3>正在工作 <span class="badge warn">${escapeHtml(activeWorkers.length)}</span></h3>
        ${activeWorkers.length ? activeWorkers.map(laneCard).join("") : `<div class="lane-item"><strong>没有执行中的 worker</strong>总质检会继续派生下一批，不会停在这里。</div>`}
      </div>
      <div class="lane qa">
        <h3>等总质检 <span class="badge">${escapeHtml(waitingQa.length + counts.pending)}</span></h3>
        ${waitingQa.length ? waitingQa.map(laneCard).join("") : `<div class="lane-item"><strong>没有待质检结果</strong>worker 完成后会进入这里，由总质检复核。</div>`}
      </div>
      <div class="lane merge">
        <h3>可合并 <span class="badge good">${escapeHtml(mergeReady.length)}</span></h3>
        ${mergeReady.length ? mergeReady.map(laneCard).join("") : `<div class="lane-item"><strong>暂无可合并</strong>需要 100/100、证据齐全、总质检确认。</div>`}
      </div>
      <div class="lane next">
        <h3>下一批 <span class="badge warn">${escapeHtml(nextWorkers.length || activeWorkers.length ? nextWorkers.length : 1)}</span></h3>
        ${nextWorkers.length ? nextWorkers.map((worker) => `<div class="lane-item"><strong>${escapeHtml(worker)}</strong>由总质检派生，继续补齐体验或验证。</div>`).join("") : `<div class="lane-item"><strong>继续发现新点</strong>当前批次通过后，Steve 会继续找更高价值优化。</div>`}
      </div>
    </div>
  `;
}

function renderTargets() {
  $("target").innerHTML = state.targets.map((target) => (
    `<option value="${escapeHtml(target.id)}">${escapeHtml(target.name)}</option>`
  )).join("");
  $("target").value = state.targetId;
  const targetRuns = state.runs.filter((run) => run.targetId === state.targetId);
  $("run").innerHTML = targetRuns.length
    ? targetRuns.map((run) => {
      const label = `${new Date(run.createdAt).toLocaleString()} · ${run.items?.length || 0} 个候选`;
      return `<option value="${escapeHtml(run.id)}">${escapeHtml(label)}</option>`;
    }).join("")
    : `<option value="">暂无 run</option>`;
  $("run").value = state.run?.id || "";
  const target = state.targets.find((item) => item.id === state.targetId);
  const windowText = target?.nightWindow
    ? `夜间窗口：${(target.nightWindow.slots || []).join(" / ")}，${target.nightWindow.timezone || "local"}，目标 ${target.nightWindow.targetHours || "-"} 小时`
    : "未配置夜间窗口";
  $("target-info").textContent = target
    ? `${target.description || ""} 本地地址：${target.appUrl}；仓库：${target.root}；${windowText}`
    : "未配置目标项目";
  $("target-health").innerHTML = target?.health
    ? [
      healthBadge("Git", target.health.git),
      healthBadge("App", target.health.app),
      healthBadge("Worktree", target.health.worktree),
    ].join("")
    : "";
}

function renderStats() {
  const items = state.run?.items || [];
  const visual = items.find((item) => item.id === "visual-quality-score")?.visualScore;
  const counts = decisionCounts(items);
  const workers = items.filter(isWorkerItem);
  const active = workers.filter((item) => ["handoff-ready", "context-ready", "in-progress", "needs-polish"].includes(item.status)).length;
  const pendingQa = workers.filter((item) => item.status === "codex-completed" && morningDecision(item).kind !== "merge").length + counts.pending;
  const stats = [
    ["正在工作", active],
    ["等总质检", pendingQa],
    ["可合并", counts.merge],
    ["视觉分", visual?.score == null ? "—" : `${visual.score}`],
  ];
  $("stats").innerHTML = stats.map(([label, value]) => (
    `<div class="stat"><b>${value}</b><span>${label}</span></div>`
  )).join("");
}

function renderSummary() {
  const root = $("summary");
  if (!state.run) {
    root.innerHTML = `
      <section class="summary-card">
        <h2>Steve 还没开始</h2>
        <p>点“让 Steve 继续工作”，它会先跑视觉评分，再登记 Codex App 任务。</p>
      </section>
      <section class="summary-card">
        <h2>等待目标</h2>
        <p>当前 target 会在健康检查通过后开始。</p>
      </section>
    `;
    return;
  }
  const items = state.run.items || [];
  const visualItem = items.find((item) => item.id === "visual-quality-score");
  const visual = visualItem?.visualScore;
  const needs = items.filter((item) => ["needs-polish", "failed"].includes(item.status));
  const handoffs = items.filter((item) => item.codexSessions?.some((s) => s.mode === "app-handoff"));
  const coordination = state.run.coordination;
  const counts = decisionCounts(items);
  const topNeeds = needs.slice(0, 3).map((item) => (
    `<div class="insight"><strong>${escapeHtml(item.title)}</strong>：${escapeHtml(item.validationNotes || item.proposal || item.finding)}</div>`
  )).join("");
  root.innerHTML = `
    <section class="summary-card">
      <h2>${visual?.passed ? "当前基线可用" : "正在建立基线"}</h2>
      <p>
        ${visual?.score == null
          ? "视觉评分尚未完成。"
          : `CodeNext 视觉评分 <strong>${escapeHtml(visual.score)}/${escapeHtml(visual.maxScore || 100)}</strong>。`}
        当前登记 worker <strong>${escapeHtml(coordination?.workerCount ?? handoffs.length)}</strong> 个。
      </p>
      <div class="insights">
        <div class="insight"><strong>质检结果</strong>：可合并 ${escapeHtml(counts.merge)}，继续优化 ${escapeHtml(counts.continue)}，人工确认 ${escapeHtml(counts.human)}，等待回收 ${escapeHtml(counts.pending)}。</div>
        ${topNeeds || `<div class="insight">当前没有需要你立即决策的阻断项。</div>`}
      </div>
    </section>
    <section class="summary-card">
      <h2>下一步</h2>
      <p>${needs.length ? "优先处理需打磨项；Steve 会继续拆给 worker，并由总质检回收。" : "可合并项会进入合并候选；同时 Steve 会继续派生下一批优化。"}</p>
      <p><strong>批次</strong>：当前体验优化批次</p>
    </section>
  `;
}

function visibleItems() {
  const query = state.query.toLowerCase();
  return (state.run?.items || []).filter((item) => {
    if (!state.advanced && item.status === "rejected") return false;
    if (!query) return true;
    return [
      item.title,
      item.type,
      item.agent,
      item.skill,
      item.finding,
      item.proposal,
      item.branch,
      item.worktreePath,
    ].join(" ").toLowerCase().includes(query);
  }).sort((a, b) => {
    const rank = (item) => {
      const decision = morningDecision(item).kind;
      if (["handoff-ready", "context-ready", "in-progress", "needs-polish"].includes(item.status)) return 0;
      if (decision === "merge") return 1;
      if (decision === "continue" || decision === "human") return 2;
      if (item.id === "visual-quality-score") return 4;
      if (item.status === "rejected") return 9;
      return 3;
    };
    return rank(a) - rank(b) || (b.valueScore || 0) - (a.valueScore || 0);
  });
}

function renderItems() {
  const root = $("items");
  if (!state.run) {
    root.innerHTML = `<div class="empty">先选择目标项目并生成体验计划。</div>`;
    return;
  }
  const items = visibleItems();
  if (!items.length) {
    root.innerHTML = `<div class="empty">当前搜索下没有候选点。</div>`;
    return;
  }
  root.innerHTML = items.map((item) => `
    <article class="item">
      <div class="item-head">
        <div>
          <h2>${escapeHtml(item.title)}</h2>
          <div class="badges">
            <span class="badge ${item.selected ? "good" : ""}">${item.selected ? "已选择" : "未选择"}</span>
            <span class="badge ${item.recommendation === "recommended" ? "good" : "warn"}">${escapeHtml(item.recommendation)}</span>
            <span class="badge ${riskClass(item.risk)}">${escapeHtml(item.risk)}</span>
            <span class="badge">${statusLabel(item.status)}</span>
            <span class="badge ${morningDecision(item).cls}">${escapeHtml(morningDecision(item).label)}</span>
            <span class="badge">${escapeHtml(item.skill)}</span>
          </div>
        </div>
        <div class="score">${item.valueScore}<span>价值</span></div>
      </div>
      <p><strong>观察：</strong>${escapeHtml(item.finding)}</p>
      <p><strong>建议：</strong>${escapeHtml(item.proposal)}</p>
      <div class="checks">${(item.checklist || []).map((line) => `<div class="check">${escapeHtml(line)}</div>`).join("")}</div>
      ${renderQualityGate(item)}
      <div class="run-meta">
        <span class="mini-pill">${escapeHtml(executionLabel(item))}</span>
        ${item.resultPath || latestAppSession(item)?.resultPath ? `<span class="mini-pill good">报告已回收</span>` : ""}
      </div>
      ${renderInternalPaths(item)}
      ${renderVisualScore(item)}
      ${renderSessions(item)}
      <div class="item-actions ${state.advanced ? "" : "collapsed"}">
        <button data-action="toggle" data-id="${escapeHtml(item.id)}">${item.selected ? "取消选择" : "选择合并"}</button>
        <button data-action="worktree" data-id="${escapeHtml(item.id)}">创建 worktree</button>
        <button data-action="context" data-id="${escapeHtml(item.id)}">准备上下文</button>
        <button data-action="codex" data-id="${escapeHtml(item.id)}">登记 App 任务</button>
        <button data-action="validated" data-id="${escapeHtml(item.id)}">标记已复验</button>
        <button data-action="reject" data-id="${escapeHtml(item.id)}">搁置</button>
      </div>
    </article>
  `).join("");
}

function renderQualityGate(item) {
  const score = qualityScore(item);
  const evidence = item.evidencePaths || latestAppSession(item)?.evidencePaths || [];
  const changed = item.changedPaths || latestAppSession(item)?.changedPaths || [];
  if (score == null && !evidence.length && !changed.length) return "";
  return `
    <div class="checks">
      ${score == null ? "" : `<div class="check">质量门槛：${escapeHtml(score)}/100</div>`}
      ${evidence.length ? `<div class="check">证据：${state.advanced ? evidence.map(escapeHtml).join("；") : `${evidence.length} 项证据已登记`}</div>` : ""}
      ${changed.length ? `<div class="check">改动：${changed.map(escapeHtml).join("；")}</div>` : ""}
    </div>
  `;
}

function renderSessions(item) {
  if (!item.codexSessions?.length) return "";
  return `
    <div class="checks">
      ${item.codexSessions.slice(-3).map((session) => `
        <div class="check">
          Codex ${escapeHtml(session.mode)}：${escapeHtml(session.status)}
          ${session.pid ? ` · PID ${escapeHtml(session.pid)}` : ""}
          ${session.contextPath ? ` · ${state.advanced ? `context ${escapeHtml(session.contextPath)}` : "上下文已准备"}` : ""}
          ${session.resultPath ? ` · ${state.advanced ? `result ${escapeHtml(session.resultPath)}` : "报告已回收"}` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function renderVisualScore(item) {
  if (!item.visualScore) return "";
  const score = item.visualScore.score == null ? "未评分" : `${item.visualScore.score}/${item.visualScore.maxScore || 100}`;
  return `
    <div class="checks">
      <div class="check">
        视觉评分：${escapeHtml(score)} · 阈值 ${escapeHtml(item.visualScore.minScore)} · ${item.visualScore.passed ? "通过" : "未通过"}
      </div>
      <div class="check">报告：${escapeHtml(item.visualScore.reportPath || "")}</div>
    </div>
  `;
}

function renderReport() {
  $("report").textContent = state.run?.report || "暂无报告";
}

function renderPlan() {
  if (!state.plan) {
    $("plan").textContent = "暂无合并计划";
    return;
  }
  $("plan").textContent = [
    `目标仓库：${state.plan.targetRoot}`,
    `基础分支：${state.plan.baseBranch}`,
    "",
    "候选改动：",
    ...state.plan.selected.map((item) => `- ${item.title}\n  状态：${item.status || "待确认"}\n  执行环境：隔离工作区`),
    "",
    "合并操作：",
    state.advanced ? state.plan.commands.join("\n") : "请在高级操作中查看实际合并命令。",
  ].join("\n");
}

function render() {
  renderTargets();
  renderStats();
  renderSummary();
  renderFlow();
  renderItems();
  renderReport();
  renderPlan();
  $("toolbar").hidden = !state.advanced;
  $("toggle-advanced").textContent = state.advanced ? "收起高级操作" : "高级操作";
  document.querySelectorAll(".advanced-only").forEach((node) => {
    node.hidden = !state.advanced;
  });
}

async function load() {
  const targetData = await api("/api/targets");
  state.targets = targetData.targets || [];
  if (!state.targets.some((target) => target.id === state.targetId)) {
    state.targetId = state.targets[0]?.id || "";
  }
  const runData = await api("/api/runs");
  state.runs = runData.runs || [];
  state.run = state.runs.find((run) => run.id === state.run?.id)
    || state.runs.find((run) => run.targetId === state.targetId)
    || null;
  state.plan = state.run ? (await api(`/api/runs/${encodeURIComponent(state.run.id)}/merge-plan`)) : null;
  render();
}

async function createRun() {
  setBusy(true);
  try {
    const data = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ targetId: state.targetId }),
    });
    state.run = data.run;
    state.runs = [data.run, ...state.runs.filter((run) => run.id !== data.run.id)];
    state.plan = null;
    toast("体验计划已生成");
    render();
  } finally {
    setBusy(false);
  }
}

async function autoRun() {
  setBusy(true);
  try {
    const data = await api("/api/auto-run", {
      method: "POST",
      body: JSON.stringify({ targetId: state.targetId }),
    });
    state.run = data.run;
    state.runs = [data.run, ...state.runs.filter((run) => run.id !== data.run.id)];
    state.plan = data.mergePlan || null;
    toast("Steve 已开始自动工作，视觉评分已回写");
    render();
  } finally {
    setBusy(false);
  }
}

async function updateItem(id, patch, message) {
  if (!state.run) return;
  setBusy(true);
  try {
    const data = await api(`/api/runs/${encodeURIComponent(state.run.id)}/items/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    state.run = data.run;
    state.plan = null;
    toast(message);
    render();
  } finally {
    setBusy(false);
  }
}

async function createWorktree(id) {
  if (!state.run) return;
  setBusy(true);
  try {
    const data = await api(`/api/runs/${encodeURIComponent(state.run.id)}/items/${encodeURIComponent(id)}/worktree`, {
      method: "POST",
      body: "{}",
    });
    state.run = data.run;
    state.plan = null;
    toast("worktree 已就绪");
    render();
  } finally {
    setBusy(false);
  }
}

async function startCodex(id, dryRun) {
  if (!state.run) return;
  setBusy(true);
  try {
    const data = await api(`/api/runs/${encodeURIComponent(state.run.id)}/items/${encodeURIComponent(id)}/codex-session`, {
      method: "POST",
      body: JSON.stringify({ dryRun, executor: "app-handoff" }),
    });
    state.run = data.run;
    state.runs = [data.run, ...state.runs.filter((run) => run.id !== data.run.id)];
    state.plan = null;
    toast(dryRun ? "Codex 上下文已准备" : "已登记给当前 Codex App 接管");
    render();
  } finally {
    setBusy(false);
  }
}

async function generatePlan() {
  if (!state.run) return toast("请先生成体验计划");
  state.plan = await api(`/api/runs/${encodeURIComponent(state.run.id)}/merge-plan`);
  renderPlan();
  toast("合并计划已更新");
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || state.busy) return;
  try {
    if (button.id === "refresh") return await load().then(() => toast("已刷新"));
    if (button.id === "toggle-advanced") {
      state.advanced = !state.advanced;
      render();
      return;
    }
    if (button.id === "auto") return await autoRun();
    if (button.id === "create") return await createRun();
    if (button.id === "merge") return await generatePlan();
    const id = button.dataset.id;
    const action = button.dataset.action;
    if (!id || !action) return;
    const item = state.run?.items.find((candidate) => candidate.id === id);
    if (!item) return;
    if (action === "toggle") return await updateItem(id, { selected: !item.selected }, item.selected ? "已取消选择" : "已选择候选点");
    if (action === "worktree") return await createWorktree(id);
    if (action === "context") return await startCodex(id, true);
    if (action === "codex") return await startCodex(id, false);
    if (action === "validated") return await updateItem(id, { status: "validated" }, "已标记复验");
    if (action === "reject") return await updateItem(id, { status: "rejected", selected: false, recommendation: "rejected" }, "已搁置");
  } catch (err) {
    toast(err.message);
  }
});

$("target").addEventListener("change", async (event) => {
  state.targetId = event.target.value;
  state.run = null;
  state.plan = null;
  await load().catch((err) => toast(err.message));
});

$("run").addEventListener("change", async (event) => {
  state.run = state.runs.find((run) => run.id === event.target.value) || null;
  state.plan = state.run ? await api(`/api/runs/${encodeURIComponent(state.run.id)}/merge-plan`).catch(() => null) : null;
  render();
});

$("search").addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  renderItems();
});

load().catch((err) => {
  toast(err.message);
  render();
});
