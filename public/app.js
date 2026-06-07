const state = {
  targets: [],
  runs: [],
  targetId: "codenext",
  run: null,
  operator: null,
  operatorLoop: null,
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
    "handoff-ready": "待 Operator 派生",
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

function codexSessionState(session) {
  if (!session) return { label: "未登记", cls: "" };
  if (session.hasResult || session.status === "completed") return { label: "已回收", cls: "good" };
  if (session.status === "running") return { label: "执行中", cls: "warn" };
  if (session.status === "context-ready") return { label: "上下文就绪", cls: "blue" };
  if (session.status === "handoff-ready") return { label: "待 Operator 派生", cls: "warn" };
  return { label: statusLabel(session.status), cls: "" };
}

function agentInitials(item) {
  const title = String(item.agent || item.title || "Codex").trim();
  const parts = title.split(/\s+/).filter(Boolean);
  if (!parts.length) return "C";
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function collaborationProfile(items) {
  const allWorkers = items.filter(isWorkerItem);
  const workers = state.advanced ? allWorkers : allWorkers.filter((item) => item.status !== "rejected");
  const activeWorkers = workers.filter((item) => item.status === "in-progress" || latestAppSession(item)?.status === "running");
  const mergeReady = workers.filter((item) => morningDecision(item).kind === "merge");
  const waitingQa = workers.filter((item) => item.status === "codex-completed" && morningDecision(item).kind !== "merge");
  const nextWorkers = allNextWorkers(items);
  const handoffReady = workers.filter((item) => latestAppSession(item)?.status === "handoff-ready");
  const contextReady = workers.filter((item) => latestAppSession(item)?.status === "context-ready");
  const completed = workers.filter((item) => latestAppSession(item)?.hasResult || latestAppSession(item)?.status === "completed");
  const maxParallel = Number(state.run?.coordination?.maxParallelCodex || state.run?.coordination?.workerCount || 4);
  const visibleCapacity = Math.max(maxParallel, activeWorkers.length, 1);
  const idleSlots = Math.max(0, visibleCapacity - activeWorkers.length);
  return {
    workers,
    activeWorkers,
    mergeReady,
    waitingQa,
    nextWorkers,
    handoffReady,
    contextReady,
    completed,
    counts: decisionCounts(items),
    maxParallel: visibleCapacity,
    idleSlots,
    manageable: workers.length,
  };
}

function workerSlotCard(item, index) {
  if (!item) {
    return `
      <div class="worker-slot idle">
        <div class="slot-orb">IDLE</div>
        <div>
          <strong>Worker ${escapeHtml(index + 1)}</strong>
          <p>空闲，可接收一个 focused 任务</p>
        </div>
        <span class="slot-state">ready</span>
      </div>
    `;
  }
  const session = latestAppSession(item);
  const sessionState = codexSessionState(session);
  return `
    <div class="worker-slot ${sessionState.cls || "active"}">
      <div class="slot-orb">${escapeHtml(agentInitials(item))}</div>
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(itemSubtitle(item, 78))}</p>
      </div>
      <span class="slot-state">${escapeHtml(sessionState.label)}</span>
    </div>
  `;
}

function directiveValue() {
  return $("steve-directive")?.value.trim() || "";
}

function operatorOnline() {
  return Boolean(state.operator?.active || state.run?.currentCodexOperator?.active || state.run?.currentCodexOperator?.status === "active");
}

function loopActive() {
  return Boolean(state.operatorLoop?.active || state.operatorLoop?.status === "active");
}

function agentWorkerCard(item) {
  const session = latestAppSession(item);
  const sessionState = codexSessionState(session);
  const decision = morningDecision(item);
  const score = qualityScore(item);
  const completed = session?.hasResult || session?.status === "completed" || item.status === "codex-completed";
  return `
    <article class="agent-card">
      <div class="agent-avatar ${sessionState.cls || ""}">${escapeHtml(agentInitials(item))}</div>
      <div class="agent-card-main">
        <div class="agent-card-top">
          <h3>${escapeHtml(item.title)}</h3>
          <span class="badge ${sessionState.cls}">${escapeHtml(sessionState.label)}</span>
        </div>
        <p>${escapeHtml(itemSubtitle(item))}</p>
        <div class="agent-card-meta">
          <span class="mini-pill">${escapeHtml(item.agent || "Codex worker")}</span>
          <span class="mini-pill blue">${escapeHtml(item.skill || "自动选 skill")}</span>
          <span class="mini-pill ${decision.cls || ""}">${escapeHtml(decision.label)}</span>
          ${score == null ? "" : `<span class="mini-pill ${score === 100 ? "good" : "warn"}">${escapeHtml(score)}/100</span>`}
        </div>
        <div class="agent-actions">
          ${completed
            ? `<button class="control-btn" data-action="validated" data-id="${escapeHtml(item.id)}">复验通过</button>`
            : `<button class="control-btn primary" data-action="operator-claim" data-id="${escapeHtml(item.id)}">${session?.status === "running" ? "刷新执行态" : "Operator 认领"}</button>`}
          <button class="control-btn" data-action="context" data-id="${escapeHtml(item.id)}">准备上下文</button>
          <button class="control-btn" data-action="copy-handoff" data-id="${escapeHtml(item.id)}">复制接管提示</button>
        </div>
      </div>
    </article>
  `;
}

function compactWorkerItem(item) {
  const session = latestAppSession(item);
  const sessionState = codexSessionState(session);
  return `
    <div class="queue-item">
      <span class="queue-dot ${sessionState.cls || ""}"></span>
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(itemSubtitle(item, 82))}</small>
      </div>
      <span class="badge ${sessionState.cls}">${escapeHtml(sessionState.label)}</span>
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
          <h2>Codex App 协作看板</h2>
          <p>Steve 还没有 run。点“让 Steve 继续工作”后，这里会显示当前可管理的 Codex worker、质检和下一批派生。</p>
        </div>
      </div>
    `;
    return;
  }
  const items = state.run.items || [];
  const {
    workers,
    activeWorkers,
    mergeReady,
    waitingQa,
    nextWorkers,
    handoffReady,
    contextReady,
    completed,
    counts,
    maxParallel,
    idleSlots,
    manageable,
  } = collaborationProfile(items);
  const qc = state.run.coordination?.qualityController || {};
  const qcActive = activeWorkers.length || waitingQa.length || nextWorkers.length || mergeReady.length;
  const capacityText = `${Math.min(activeWorkers.length, maxParallel)}/${maxParallel}`;
  const handoffText = handoffReady.length
    ? `${handoffReady.length} 个待 Operator 派生`
    : (contextReady.length ? `${contextReady.length} 个上下文已准备` : "暂无待派生任务");
  const operator = state.operator || state.run.currentCodexOperator || {};
  const loop = state.operatorLoop || state.run.operatorLoop || {};

  const slots = Array.from({ length: maxParallel }, (_, index) => workerSlotCard(activeWorkers[index], index)).join("");

  root.innerHTML = `
    <div class="fleet-hero">
      <div class="fleet-radar">
        <span class="eyebrow"><span class="pulse-dot"></span>Agent Fleet Control</span>
        <h2>${escapeHtml(idleSlots)} 个 worker 空闲</h2>
        <p>当前 ${escapeHtml(activeWorkers.length)} 个忙碌，${escapeHtml(manageable)} 个会话可管理。你可以给空闲 worker 下发任务，也可以给 Steve 一个方向让它自动探索。</p>
        <div class="fleet-metrics">
          <span><b>${escapeHtml(activeWorkers.length)}</b> busy</span>
          <span><b>${escapeHtml(idleSlots)}</b> idle</span>
          <span><b>${escapeHtml(handoffReady.length)}</b> queued</span>
          <span><b>${escapeHtml(mergeReady.length)}</b> merge</span>
        </div>
      </div>
      <div class="command-deck">
        <div class="deck-head">
          <strong>给 Steve 一个方向</strong>
          <span class="badge ${operatorOnline() ? "good" : "warn"}">${operatorOnline() ? "Codex Operator 在线" : "Operator 未连接"}</span>
        </div>
        <div class="operator-strip">
          <span>${escapeHtml(operator.label || "当前 Codex App 会话")}</span>
          <span>${escapeHtml(operator.runtime || "codex-app")}</span>
          <span>${escapeHtml(operator.lastSeenAt ? `心跳 ${new Date(operator.lastSeenAt).toLocaleTimeString()}` : "等待心跳")}</span>
          <span>${escapeHtml(loopActive() ? "Loop active" : "Loop paused")}</span>
        </div>
        <textarea id="steve-directive" placeholder="例如：探索知识库、多 agent 协作、Slack/钉钉集成、云端 AI 编程工作台体验瓶颈..."></textarea>
        <div class="directive-chips">
          <button class="chip" data-directive="探索知识库和检索增强能力，让 CodeNext 更像云端 AI 编程工作台">知识库</button>
          <button class="chip" data-directive="探索多 AI agent 协作、任务派发、上下文回收和质检闭环">多 agent</button>
          <button class="chip" data-directive="探索 Slack、钉钉、飞书通知与协作入口，提升团队工作流">协作通知</button>
          <button class="chip" data-directive="从苹果式丝滑体验出发，寻找最高价值的交互优化点">体验打磨</button>
        </div>
        <div class="deck-actions">
          <button class="control-btn ${operatorOnline() ? "" : "primary"}" data-action="register-operator">${operatorOnline() ? "刷新 Operator" : "连接为 Codex Operator"}</button>
          <button class="control-btn" data-action="operator-heartbeat">Operator 心跳</button>
          <button class="control-btn ${loopActive() ? "" : "primary"}" data-action="operator-loop-start">${loopActive() ? "刷新 Loop" : "启动 Loop"}</button>
          <button class="control-btn" data-action="operator-loop-tick">执行下一 tick</button>
          <button class="control-btn" data-action="operator-loop-pause">暂停 Loop</button>
          <button class="control-btn primary" data-action="dispatch-directive">加入 Operator 队列</button>
          <button class="control-btn" data-action="discover-directive">自动发现任务</button>
          <button class="control-btn" data-action="notify-codex">同步队列给 Operator</button>
        </div>
      </div>
    </div>

    <div class="fleet-slots">
      ${slots}
    </div>

    <div class="control-grid">
      <section class="agent-roster">
        <div class="section-line">
          <div>
            <h3>协作中的 Codex 会话</h3>
            <p>只有真实 Codex worker 被 Operator 派生并认领后，才会进入忙碌槽位。</p>
          </div>
          <span class="badge good">${escapeHtml(workers.length)} 个会话 · ${escapeHtml(idleSlots)} 空闲</span>
        </div>
        <div class="agent-cards">
          ${workers.length ? workers.map(agentWorkerCard).join("") : `<div class="empty compact">还没有 Codex App worker。启动自动工作后会自动登记。</div>`}
        </div>
      </section>

      <aside class="ops-queue">
        <div class="section-line">
          <div>
            <h3>管理队列</h3>
            <p>按你早上最需要看的顺序排列。</p>
          </div>
        </div>
        <div class="queue-block">
          <div class="queue-title">待 Operator 派生 <span>${escapeHtml(handoffReady.length + contextReady.length)}</span></div>
          ${(handoffReady.length || contextReady.length) ? [...handoffReady, ...contextReady].slice(0, 4).map(compactWorkerItem).join("") : `<div class="queue-empty">暂无待派生 worker</div>`}
        </div>
        <div class="queue-block">
          <div class="queue-title">等总质检 <span>${escapeHtml(waitingQa.length + counts.pending)}</span></div>
          ${waitingQa.length ? waitingQa.slice(0, 4).map(compactWorkerItem).join("") : `<div class="queue-empty">完成结果会进入这里</div>`}
        </div>
        <div class="queue-block">
          <div class="queue-title">可合并 <span>${escapeHtml(mergeReady.length)}</span></div>
          ${mergeReady.length ? mergeReady.slice(0, 4).map(compactWorkerItem).join("") : `<div class="queue-empty">需要 100/100 + 证据齐全</div>`}
        </div>
        <div class="queue-block">
          <div class="queue-title">下一批派生 <span>${escapeHtml(nextWorkers.length || 1)}</span></div>
          ${nextWorkers.length ? nextWorkers.slice(0, 5).map((worker) => `<div class="queue-item"><span class="queue-dot warn"></span><div><strong>${escapeHtml(worker)}</strong><small>总质检建议继续推进</small></div></div>`).join("") : `<div class="queue-empty">Steve 会继续发现新优化点</div>`}
        </div>
      </aside>
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
  const repoText = state.advanced ? target?.root : (target?.name || target?.id || "目标项目");
  const windowText = target?.nightWindow
    ? `夜间窗口：${(target.nightWindow.slots || []).join(" / ")}，${target.nightWindow.timezone || "local"}，目标 ${target.nightWindow.targetHours || "-"} 小时`
    : "未配置夜间窗口";
  $("target-info").textContent = target
    ? `${target.description || ""} 本地地址：${target.appUrl}；仓库：${repoText}；${windowText}`
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
  const active = workers.filter((item) => item.status === "in-progress" || latestAppSession(item)?.status === "running").length;
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
  state.operator = (await api("/api/codex/operator").catch(() => ({ operator: null }))).operator || null;
  state.operatorLoop = (await api("/api/codex/operator/loop").catch(() => ({ loop: null }))).loop || null;
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
    toast(dryRun ? "Codex 上下文已准备" : "已加入 Operator inbox");
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

async function notifyCodexApp() {
  if (!state.run) return toast("请先生成体验计划");
  setBusy(true);
  try {
    const data = await api(`/api/runs/${encodeURIComponent(state.run.id)}/codex-notification`, {
      method: "POST",
      body: JSON.stringify({ reason: "Steve Web console requested Codex App handoff." }),
    });
    state.run = data.run;
    state.runs = [data.run, ...state.runs.filter((run) => run.id !== data.run.id)];
    toast(`已同步 Operator 队列：${data.notification?.restartItemCount ?? 0} 个任务可派生`);
    render();
  } finally {
    setBusy(false);
  }
}

async function registerOperator() {
  setBusy(true);
  try {
    const data = await api("/api/codex/operator", {
      method: "POST",
      body: JSON.stringify({ label: "当前 Codex App 会话" }),
    });
    state.operator = data.operator;
    toast("当前 Codex App 已连接为 Steve Operator");
    render();
  } finally {
    setBusy(false);
  }
}

async function heartbeatOperator() {
  setBusy(true);
  try {
    const data = await api("/api/codex/operator/heartbeat", {
      method: "POST",
      body: JSON.stringify({ label: "当前 Codex App 会话", message: "Operator heartbeat from Steve Web" }),
    });
    state.operator = data.operator;
    toast("Codex Operator 心跳已更新");
    render();
  } finally {
    setBusy(false);
  }
}

async function updateOperatorLoop(action) {
  setBusy(true);
  try {
    const data = await api("/api/codex/operator/loop", {
      method: "POST",
      body: JSON.stringify({
        action,
        targetId: state.targetId,
        directive: directiveValue(),
        autoDiscover: true,
      }),
    });
    state.operatorLoop = data.loop;
    toast(action === "pause" ? "Operator Loop 已暂停" : "Operator Loop 已启动");
    render();
  } finally {
    setBusy(false);
  }
}

async function tickOperatorLoop() {
  setBusy(true);
  try {
    const data = await api("/api/codex/operator/loop/tick", {
      method: "POST",
      body: JSON.stringify({
        targetId: state.targetId,
        directive: directiveValue(),
        autoDiscover: true,
      }),
    });
    state.operatorLoop = data.loop;
    state.operator = data.inbox?.operator || state.operator;
    await load();
    toast(data.nextAction?.type === "spawn-worker" ? `下一 tick：${data.nextAction.title}` : (data.nextAction?.message || "Loop tick 已执行"));
  } finally {
    setBusy(false);
  }
}

async function claimWorker(id) {
  if (!state.run) return toast("请先生成体验计划");
  setBusy(true);
  try {
    if (!operatorOnline()) {
      const operatorData = await api("/api/codex/operator", {
        method: "POST",
        body: JSON.stringify({ label: "当前 Codex App 会话" }),
      });
      state.operator = operatorData.operator;
    }
    const data = await api(`/api/runs/${encodeURIComponent(state.run.id)}/items/${encodeURIComponent(id)}/operator-claim`, {
      method: "POST",
      body: JSON.stringify({ operator: state.operator }),
    });
    state.run = data.run;
    state.runs = [data.run, ...state.runs.filter((run) => run.id !== data.run.id)];
    state.operator = data.operator;
    toast("worker 已由 Codex Operator 认领为执行中");
    render();
  } finally {
    setBusy(false);
  }
}

function directiveTaskPayload(directive, mode) {
  const clean = shortText(directive, 72) || "探索下一个高价值产品优化点";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+z$/i, "z").toLowerCase();
  return {
    id: `${mode}-${stamp}`,
    title: mode === "discover" ? `自动探索：${clean}` : `人工启发：${clean}`,
    type: mode === "discover" ? "discovery" : "optimization",
    valueScore: mode === "discover" ? 94 : 96,
    risk: "medium",
    agent: mode === "discover" ? "Steve discovery worker" : "focused Codex worker",
    skill: "auto-discovered",
    finding: mode === "discover"
      ? `用户给出启发方向：${directive || "继续寻找高价值优化点"}。Steve 需要主动发现值得推进的产品机会。`
      : `用户直接下发方向：${directive || "完成一个 focused 产品优化点"}。`,
    proposal: mode === "discover"
      ? "从产品体验、技术可行性、验证成本和用户价值出发，提出可执行任务并回写中文报告。"
      : "围绕该方向完成一个最小闭环优化，必要时自动发现合适 skill，并交给总质检复核。",
    checklist: [
      "先判断是否需要 skill，并记录选择理由",
      "用真实页面、接口或代码证据验证结论",
      "输出中文 result.md",
      "给出质量评分、合并建议和下一轮 worker",
    ],
    selected: true,
    recommendation: "recommended",
    status: "handoff-ready",
  };
}

async function createDirectedWorker(mode) {
  if (!state.run) return toast("请先生成体验计划");
  const directive = directiveValue();
  if (!directive && mode !== "discover") return toast("先输入一个方向，再派发给空闲 worker");
  setBusy(true);
  try {
    const payload = directiveTaskPayload(directive, mode);
    const data = await api(`/api/runs/${encodeURIComponent(state.run.id)}/items/register`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.run = data.run;
    state.runs = [data.run, ...state.runs.filter((run) => run.id !== data.run.id)];
    await notifyCodexApp();
    toast(mode === "discover" ? "自动探索任务已进入 Operator inbox" : "任务已进入 Operator inbox，等待真实 Codex worker 派生");
    render();
  } finally {
    setBusy(false);
  }
}

async function copyHandoffPrompt(item) {
  const text = [
    `请作为 Steve Codex Operator 派生 worker：「${item.title}」。`,
    `状态：${statusLabel(item.status)}；建议 skill：${item.skill || "自动选择"}。`,
    "请先读取 Steve 当前 run 的共享上下文和 coordination，然后只处理这个 worker 对应的产品优化点。",
    "完成后用中文回写：结论、改动摘要、验证证据、质量评分、是否建议合并、下一轮 worker 建议。",
    "注意：目标产品仓库的提交信息和用户可见文案不要暴露 Steve、run、worker、worktree 或用户原话需求。",
  ].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Operator 派生提示已复制，可粘贴给 Codex App 会话");
  } catch {
    toast("浏览器未允许复制，请在任务详情里查看该 worker");
  }
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
    if (action === "notify-codex") return await notifyCodexApp();
    if (action === "register-operator") return await registerOperator();
    if (action === "operator-heartbeat") return await heartbeatOperator();
    if (action === "operator-loop-start") return await updateOperatorLoop("start");
    if (action === "operator-loop-pause") return await updateOperatorLoop("pause");
    if (action === "operator-loop-tick") return await tickOperatorLoop();
    if (action === "dispatch-directive") return await createDirectedWorker("direct");
    if (action === "discover-directive") return await createDirectedWorker("discover");
    if (button.dataset.directive) {
      const input = $("steve-directive");
      if (input) input.value = button.dataset.directive;
      return;
    }
    if (!id || !action) return;
    const item = state.run?.items.find((candidate) => candidate.id === id);
    if (!item) return;
    if (action === "toggle") return await updateItem(id, { selected: !item.selected }, item.selected ? "已取消选择" : "已选择候选点");
    if (action === "worktree") return await createWorktree(id);
    if (action === "context") return await startCodex(id, true);
    if (action === "codex") return await startCodex(id, false);
    if (action === "operator-claim") return await claimWorker(id);
    if (action === "copy-handoff") return await copyHandoffPrompt(item);
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
