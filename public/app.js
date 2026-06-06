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
  const stats = [
    ["候选点", items.length],
    ["Codex worker", state.run?.coordination?.workerCount ?? items.filter((item) => item.codexSessions?.some((s) => s.mode === "app-handoff")).length],
    ["需打磨", items.filter((item) => ["needs-polish", "failed"].includes(item.status)).length],
    ["视觉评分", visual?.score == null ? "—" : `${visual.score}`],
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
  const topNeeds = needs.slice(0, 3).map((item) => (
    `<div class="insight"><strong>${escapeHtml(item.title)}</strong>：${escapeHtml(item.validationNotes || item.proposal || item.finding)}</div>`
  )).join("");
  root.innerHTML = `
    <section class="summary-card">
      <h2>${visual?.passed ? "视觉基线已通过" : "Steve 正在建立体验基线"}</h2>
      <p>
        ${visual?.score == null
          ? "视觉评分尚未完成。"
          : `CodeNext 当前视觉评分 <strong>${escapeHtml(visual.score)}/${escapeHtml(visual.maxScore || 100)}</strong>，阈值 ${escapeHtml(visual.minScore)}。`}
        Codex App worker 已登记 <strong>${escapeHtml(coordination?.workerCount ?? handoffs.length)}</strong> 个。
      </p>
      <div class="insights">
        ${topNeeds || `<div class="insight">当前没有需要你立即决策的阻断项。</div>`}
        ${state.run.runContextPath ? `<div class="insight"><strong>共享上下文</strong>：${escapeHtml(state.run.runContextPath)}</div>` : ""}
        ${state.run.coordinationPath ? `<div class="insight"><strong>协调计划</strong>：${escapeHtml(state.run.coordinationPath)}</div>` : ""}
      </div>
    </section>
    <section class="summary-card">
      <h2>下一步</h2>
      <p>${needs.length ? "优先处理需打磨项；Steve 会继续把问题拆给 App worker，并回收验证报告。" : "可以继续让 Steve 深挖，或查看报告后选择合并候选分支。"}</p>
      <p><strong>Run</strong>：${escapeHtml(state.run.id)}</p>
    </section>
  `;
}

function visibleItems() {
  const query = state.query.toLowerCase();
  return (state.run?.items || []).filter((item) => {
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
            <span class="badge">${escapeHtml(item.skill)}</span>
          </div>
        </div>
        <div class="score">${item.valueScore}<span>价值</span></div>
      </div>
      <p><strong>观察：</strong>${escapeHtml(item.finding)}</p>
      <p><strong>建议：</strong>${escapeHtml(item.proposal)}</p>
      <div class="checks">${(item.checklist || []).map((line) => `<div class="check">${escapeHtml(line)}</div>`).join("")}</div>
      <div class="path">${escapeHtml(item.worktreePath)}<br>${escapeHtml(item.branch)}</div>
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

function renderSessions(item) {
  if (!item.codexSessions?.length) return "";
  return `
    <div class="checks">
      ${item.codexSessions.slice(-3).map((session) => `
        <div class="check">
          Codex ${escapeHtml(session.mode)}：${escapeHtml(session.status)}
          ${session.pid ? ` · PID ${escapeHtml(session.pid)}` : ""}
          ${session.contextPath ? ` · context ${escapeHtml(session.contextPath)}` : ""}
          ${session.resultPath ? ` · result ${escapeHtml(session.resultPath)}` : ""}
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
    "候选分支：",
    ...state.plan.selected.map((item) => `- ${item.title}\n  ${item.branch}\n  ${item.path}`),
    "",
    "合并命令：",
    ...state.plan.commands,
  ].join("\n");
}

function render() {
  renderTargets();
  renderStats();
  renderSummary();
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
