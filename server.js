import http from "node:http";
import https from "node:https";
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, extname, basename, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 3610);
const HOST = process.env.HOST || "127.0.0.1";
const CONFIG_FILE = join(ROOT, "config", "targets.json");
const STATE_DIR = join(ROOT, ".steve");
const RUNS_FILE = join(STATE_DIR, "runs.json");
const CODEX_BIN = process.env.CODEX_BIN || "/Applications/Codex.app/Contents/Resources/codex";
const CODEX_EXECUTOR_MODE = process.env.STEVE_CODEX_EXECUTOR || "app-handoff";

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

function targets() {
  return readJson(CONFIG_FILE, { targets: [] }).targets || [];
}

function findTarget(id) {
  return targets().find((target) => target.id === id) || null;
}

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel && !rel.startsWith("..") && !rel.includes(`..${sep}`) && rel !== "..";
}

function gitOk(root) {
  if (!root || !existsSync(root)) return { ok: false, message: "仓库路径不存在" };
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf-8",
    timeout: 3000,
  });
  if (result.status !== 0 || result.stdout.trim() !== "true") {
    return { ok: false, message: "不是可用 git 工作树" };
  }
  return { ok: true, message: "git 工作树可用" };
}

async function appReachable(appUrl) {
  if (!appUrl) return { ok: false, message: "未配置本地地址" };
  return new Promise((resolveResult) => {
    let parsed;
    try {
      parsed = new URL(appUrl);
    } catch {
      resolveResult({ ok: false, message: "本地地址格式无效" });
      return;
    }
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(parsed, { method: "GET", timeout: 1600 }, (response) => {
      response.resume();
      const reachable = response.statusCode < 500 || response.statusCode === 401 || response.statusCode === 403;
      resolveResult({
        ok: reachable,
        status: response.statusCode,
        message: reachable ? `本地产品可访问（HTTP ${response.statusCode}）` : `本地产品返回 ${response.statusCode}`,
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolveResult({ ok: false, message: "本地产品不可访问：超时" });
    });
    req.on("error", (err) => {
      resolveResult({ ok: false, message: `本地产品不可访问：${err.message}` });
    });
    req.end();
  });
}

async function targetHealth(target) {
  const git = gitOk(target.root);
  const app = await appReachable(target.appUrl);
  const worktreeDir = target.worktreeDir || join(ROOT, "worktrees", target.id);
  const worktreeOutsideTarget = !isInside(target.root, worktreeDir);
  return {
    ok: git.ok && app.ok && worktreeOutsideTarget,
    git,
    app,
    worktree: {
      ok: worktreeOutsideTarget,
      path: worktreeDir,
      message: worktreeOutsideTarget ? "worktree 位于 Steve 项目外置目录" : "worktree 不能放在目标产品仓库内部",
    },
  };
}

function gitPrivacyFor(runOrTarget = {}) {
  return {
    noNamedWorkerBranches: true,
    sanitizeProductCommits: true,
    hideSteveInternalsFromCollaborators: true,
    ...(runOrTarget.gitPrivacy || {}),
  };
}

function usesDetachedWorkerWorktrees(runOrTarget = {}) {
  return gitPrivacyFor(runOrTarget).noNamedWorkerBranches !== false;
}

function workerBranchName(target, runId, itemId) {
  if (usesDetachedWorkerWorktrees(target)) return null;
  const stamp = runId.replace(/^steve-/, "").replace(/z$/, "");
  return `work/${target.id}/${stamp}/${itemId}`;
}

function worktreeHead(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return "";
  const result = spawnSync("git", ["-C", worktreePath, "rev-parse", "--verify", "HEAD"], {
    encoding: "utf-8",
    timeout: 3000,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

async function targetSummaries() {
  return Promise.all(targets().map(async (target) => ({
    ...target,
    health: await targetHealth(target),
  })));
}

function runs() {
  return readJson(RUNS_FILE, { runs: [] }).runs || [];
}

function sanitizeReportForDisplay(report) {
  return String(report || "")
    .replace(/（结果 [^)]+\/result\.md）/g, "（报告已回收）")
    .replace(/- 结果文件：.*\n/g, "- 结果文件：报告已回收\n")
    .replace(/- Worktree：.*\n/g, "- 执行环境：隔离工作区已准备\n")
    .replace(/- 分支：steve\/[^\n]+\n/g, "")
    .replace(/\/Users\/[^)\s；，。\n]+\/steve\/worktrees\/codenext\/[^\s；，。\n)]+/g, "隔离工作区")
    .replace(/\/Users\/[^)\s；，。\n]+\/steve\/\.steve\/runs\/[^\s；，。\n)]+\/result\.md/g, "Steve 报告")
    .replace(/\/Users\/[^)\s；，。\n]+\/steve\/artifacts\/[^\s；，。\n)]+/g, "Steve 证据")
    .replace(/steve\/codenext\/[^\s；，。\n)]+/g, "内部工作分支");
}

function sanitizeTextForDisplay(value) {
  if (value == null) return value;
  return String(value)
    .replace(/Preparing worktree \(new branch '[^']+'\)\n?/g, "准备隔离工作区失败：")
    .replace(/fatal: cannot lock ref '[^']+'[^\n]*/g, "git ref 创建失败，已切换为隐私模式下的 detached worktree。")
    .replace(/refs\/heads\/steve\/codenext\/[^\s；，。\n)]+/g, "内部工作分支")
    .replace(/steve\/codenext\/[^\s；，。\n)']+/g, "内部工作分支")
    .replace(/\/Users\/[^)\s；，。\n]+\/steve\/worktrees\/codenext\/[^\s；，。\n)]+/g, "隔离工作区")
    .replace(/\/Users\/[^)\s；，。\n]+\/steve\/artifacts\/[^\s；，。\n)]+/g, "Steve 证据");
}

function sanitizeSessionForDisplay(session = {}) {
  return {
    ...session,
    error: sanitizeTextForDisplay(session.error),
    summary: sanitizeTextForDisplay(session.summary),
    cwd: session.cwd ? "隔离工作区" : session.cwd,
    contextPath: null,
    resultPath: null,
    logPath: null,
  };
}

function sanitizeItemForDisplay(item = {}) {
  return {
    ...item,
    finding: sanitizeTextForDisplay(item.finding),
    proposal: sanitizeTextForDisplay(item.proposal),
    validationNotes: sanitizeTextForDisplay(item.validationNotes),
    branch: null,
    worktreePath: item.worktreePath ? "隔离工作区" : item.worktreePath,
    resultPath: null,
    contextPath: null,
    logPath: null,
    evidencePaths: (item.evidencePaths || []).map(() => "Steve 证据"),
    visualScore: item.visualScore ? {
      ...item.visualScore,
      reportPath: item.visualScore.reportPath ? "Steve 视觉报告" : item.visualScore.reportPath,
      reportJsonPath: null,
      stdoutPath: null,
      stderrPath: null,
      outDir: item.visualScore.outDir ? "Steve 证据" : item.visualScore.outDir,
    } : item.visualScore,
    codexSessions: (item.codexSessions || []).map(sanitizeSessionForDisplay),
  };
}

function sanitizeRunForDisplay(run) {
  return {
    ...run,
    targetRoot: run.targetName || "目标仓库",
    runContextPath: null,
    coordinationPath: null,
    targetHealth: run.targetHealth ? {
      ...run.targetHealth,
      worktree: run.targetHealth.worktree ? {
        ...run.targetHealth.worktree,
        path: "Steve 外置隔离工作区",
      } : run.targetHealth.worktree,
    } : run.targetHealth,
    items: (run.items || []).map(sanitizeItemForDisplay),
    report: sanitizeReportForDisplay(run.report),
  };
}

function displayRuns() {
  return runs().map(sanitizeRunForDisplay);
}

function saveRun(run) {
  const list = runs();
  const idx = list.findIndex((item) => item.id === run.id);
  if (idx === -1) list.unshift(run);
  else list[idx] = run;
  writeJson(RUNS_FILE, { runs: list });
  return run;
}

function runStateDir(runId) {
  return join(STATE_DIR, "runs", runId);
}

function itemStateDir(runId, itemId) {
  return join(runStateDir(runId), itemId);
}

function currentCodexDir() {
  return join(STATE_DIR, "codex");
}

function notifyCurrentCodex(run, options = {}) {
  const dir = currentCodexDir();
  mkdirSync(dir, { recursive: true });
  const notifiedAt = new Date().toISOString();
  const coordination = existsSync(run.coordinationPath || "")
    ? readJson(run.coordinationPath, null)
    : null;
  const workers = coordination?.workers || [];
  const restartItems = workers
    .filter((worker) => ["handoff-ready", "needs-polish", "context-ready"].includes(worker.status))
    .map((worker) => ({
      itemId: worker.itemId,
      title: worker.title,
      status: worker.status,
      contextPath: worker.contextPath,
      resultPath: worker.resultPath,
      worktreePath: worker.worktreePath,
      branch: worker.branch,
    }));
  const notification = {
    id: `notify-${Date.now()}-${randomBytes(2).toString("hex")}`,
    type: "steve-work-codex-update-and-restart",
    status: "pending",
    runId: run.id,
    targetId: run.targetId,
    targetName: run.targetName,
    createdAt: notifiedAt,
    reason: options.reason || "Steve automation changed; current Steve work Codex should update and restart task execution.",
    action: "update-current-steve-work-codex-and-restart-task-execution",
    runStatus: run.status,
    runContextPath: run.runContextPath || null,
    coordinationPath: run.coordinationPath || null,
    reportPath: options.reportPath || null,
    restartItems,
    instructions: [
      "读取 latest-notification.json 和 restart-request.json。",
      "刷新到当前 Steve 自动化逻辑，不要沿用旧的 blocked/merge-plan 判断。",
      "先读 run-context.md，再按 coordination.json 重启 handoff-ready 或 needs-polish 的任务。",
      "继续使用外置 worktree，Steve 产物留在 Steve repo，CodeNext 产品改动留在 CodeNext repo。",
      "完成后通过 handoff-result endpoint 或 result.md 回写中文报告。",
    ],
  };
  const latestPath = join(dir, "latest-notification.json");
  const restartPath = join(dir, "restart-request.json");
  const inboxPath = join(dir, "notifications.jsonl");
  const markdownPath = join(dir, "latest.md");
  writeFileSync(latestPath, `${JSON.stringify(notification, null, 2)}\n`, "utf-8");
  writeFileSync(restartPath, `${JSON.stringify({
    requestId: notification.id,
    runId: run.id,
    status: "requested",
    requestedAt: notifiedAt,
    action: notification.action,
    restartItems,
    runContextPath: notification.runContextPath,
    coordinationPath: notification.coordinationPath,
  }, null, 2)}\n`, "utf-8");
  appendFileSync(inboxPath, `${JSON.stringify(notification)}\n`, "utf-8");
  writeFileSync(markdownPath, [
    `# Steve 工作 Codex 更新与重启请求`,
    "",
    `- Run: ${run.id}`,
    `- Target: ${run.targetName}`,
    `- 状态: ${run.status}`,
    `- 时间: ${notifiedAt}`,
    `- Run context: ${notification.runContextPath || "未生成"}`,
    `- Coordination: ${notification.coordinationPath || "未生成"}`,
    "",
    "## 需要重启的任务",
    "",
    ...(restartItems.length
      ? restartItems.map((item) => `- ${item.title}（${item.itemId}，${item.status}）：${item.contextPath}`)
      : ["- 当前没有可重启的 handoff 任务；请先处理 run 阻塞原因。"]),
    "",
    "## 执行动作",
    "",
    ...notification.instructions.map((line) => `- ${line}`),
    "",
  ].join("\n"), "utf-8");
  run.currentCodexNotification = {
    id: notification.id,
    status: notification.status,
    notifiedAt,
    latestPath,
    restartPath,
    inboxPath,
    markdownPath,
    restartItemCount: restartItems.length,
  };
  run.updatedAt = notifiedAt;
  run.report = buildReport(run);
  saveRun(run);
  return notification;
}

function writeRunContext(run) {
  const dir = runStateDir(run.id);
  mkdirSync(dir, { recursive: true });
  const contextPath = join(dir, "run-context.md");
  const handoffItems = (run.items || []).filter((item) => item.codexSessions?.some((session) => session.mode === "app-handoff"));
  const decisionSummary = buildRunDecisionSummary(run);
  const lines = [
    `# Steve Run Context: ${run.id}`,
    "",
    "这是所有 Codex App worker 共享的父级上下文。每个 worker 都应先理解这里，再处理自己的 `context.md`。",
    "",
    "## Target",
    "",
    `- Name: ${run.targetName}`,
    `- Product mode: ${run.productMode || "general"}`,
    `- App URL: ${run.targetAppUrl}`,
    `- Repo: ${run.targetRoot}`,
    `- Base branch: ${run.baseBranch}`,
    `- Night window: ${(run.nightWindow?.slots || []).join(" / ") || "未配置"} ${run.nightWindow?.timezone || "local"}，目标 ${run.nightWindow?.targetHours || "-"} 小时`,
    `- Target health: ${run.targetHealth?.ok ? "可执行" : "需要处理"}${run.targetHealth?.checkedAt ? `，检查时间 ${run.targetHealth.checkedAt}` : ""}`,
    "",
    "## Coordination",
    "",
    "- Steve 是 coordinator：负责拆任务、生成上下文、登记 handoff、回收报告、决定下一轮。",
    "- 总质检 agent 是 post-worker controller：worker 完成后必须交给它复核，不能由 worker 自己宣布最终完成。",
    "- Codex App worker 是并行执行单元：每个 worker 只处理一个候选点，避免互相覆盖。",
    "- 所有 worker 产物必须回到 Steve artifacts 或对应 worktree，并在 Steve item 状态里登记。",
    "- 如果发现依赖另一个 worker 的结论，先在报告里声明依赖，不要猜测对方结果。",
    "- 每个候选点开始前都要判断是否需要 skill：需要时先发现/选择合适 skill，并在报告里写明选择理由与未选替代项。",
    "- Steve 的完成标准是 100 分闭环：产品路径、视觉体验、回归验证、中文解释、合并建议都完整；低于 100 分就继续派生下一轮 worker。",
    "",
    "## Skill Discovery Protocol",
    "",
    "- 默认先使用候选点推荐 skill；如果任务涉及前端体验、Playwright 验证、知识库、agent 编排、Slack/钉钉/飞书、多 agent 协作或发布检查，要主动发现更合适的 skill。",
    "- 选择 skill 时记录：目标问题、候选 skill、最终选择、为什么它能提升精准度、何时不需要 skill。",
    "- 如果没有合适 skill，也要明确写出“不使用 skill”的原因，避免隐性跳过。",
    "",
    "## Quality Gate",
    "",
    "- 100 分才算完成：核心用户路径可走通，视觉/交互足够顺，验证证据可复查，风险和下一步闭环清楚。",
    "- 任何未验证、只做静态推断、缺少失败态或缺少用户价值说明的结果都不能标记为最终完成。",
    "- 如果达不到 100 分，worker 必须给 Steve 返回下一轮优化点，而不是只提交一个半成品结论。",
    "- 总质检 agent 要重新验证 worker 声称的 100 分：至少复跑相关测试、检查 evidencePaths、确认服务已重启或变更已生效。",
    "",
    "## Post-Worker Quality Controller",
    "",
    "- 触发时机：任一 worker 完成 result.md 或 handoff-result 回写后，总质检 agent 读取 coordination.json 和所有 result.md。",
    "- 决策权：只有总质检 agent 可以把 item 标记为建议合并；worker 的 recommendation 只是输入证据。",
    "- 继续推进：低于 100 分、证据不足、服务未重启、视觉未复测或产品路径没闭环时，总质检 agent 必须生成下一轮 focused worker。",
    "- 上下文连接：总质检 agent 汇总父 run context、worker result、diff、验证命令、视觉报告和下一轮任务，并写入 Steve artifacts。",
    "- 持续演进：即使所有当前 item 都达到 100 分，也不能停止；总质检 agent 要继续发现下一批更高价值的产品优化或新功能点。",
    "- 输出要求：中文质检报告必须包含合并/继续/人工确认分桶、每个点为什么通过或没通过、下一轮 worker handoff。",
    "",
    "## Morning Recovery",
    "",
    `- 当前可建议合并：${decisionSummary.mergeReady.length}`,
    `- 当前需要继续优化：${decisionSummary.needsContinuation.length}`,
    `- 当前需要人工确认：${decisionSummary.needsHuman.length}`,
    `- 当前阻塞：${decisionSummary.blockers.length}`,
    "- 早晨只展示可决策结果：每个 worker 必须说明建议合并、暂不合并或需要人工确认。",
    "- result.md 和 handoff-result endpoint 至少要回收：qualityScore、recommendation、evidencePaths、verification、changedPaths、nextWorkers。",
    "",
    "## Workers",
    "",
    ...handoffItems.map((item) => [
      `### ${item.title}`,
      `- Item: ${item.id}`,
      `- Status: ${item.status}`,
      `- Worktree: ${item.worktreePath}`,
      `- Context: ${item.contextPath || ""}`,
      `- Expected result: ${item.codexSessions?.[item.codexSessions.length - 1]?.resultPath || ""}`,
      `- Role: ${item.agent}`,
      `- Skill: ${item.skill}`,
      `- Skill decision: start from ${item.skill}; upgrade or skip only with a written reason.`,
      `- Morning decision: ${buildMorningDecision(item).label}`,
      "",
    ].join("\n")),
    "## Return Contract",
    "",
    "Worker 完成后必须返回中文报告，并至少包含：",
    "- 结论：建议合并 / 暂不合并 / 需要人工确认",
    "- 改动摘要或体验发现",
    "- 证据路径",
    "- 验证结果",
    "- Skill 使用判断：用了什么、为什么；或为什么不需要",
    "- 100 分质量门槛：当前评分、扣分点、下一轮优化建议",
    "- 剩余风险",
    "- 建议 Steve 下一步派生的 worker",
  ];
  writeFileSync(contextPath, lines.join("\n"), "utf-8");
  run.runContextPath = contextPath;
  return contextPath;
}

function latestAppHandoffSession(item) {
  return item.codexSessions?.findLast?.((session) => session.mode === "app-handoff")
    || [...(item.codexSessions || [])].reverse().find((session) => session.mode === "app-handoff")
    || null;
}

function normalizeQualityScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function normalizeRecommendation(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["merge", "建议合并"].includes(raw)) return "merge";
  if (["needs-polish", "continue", "暂不合并", "继续优化"].includes(raw)) return "needs-polish";
  if (["human", "needs-human", "manual", "需要人工确认"].includes(raw)) return "needs-human";
  if (["reject", "abandon", "rejected", "搁置"].includes(raw)) return "reject";
  return null;
}

function buildMorningDecision(item) {
  const latest = latestAppHandoffSession(item);
  const recommendation = normalizeRecommendation(item.mergeRecommendation || latest?.recommendation);
  const qualityScore = normalizeQualityScore(item.qualityScore ?? latest?.qualityScore);
  const hasResult = Boolean(item.resultPath || latest?.hasResult);
  const hasEvidence = Boolean((item.evidencePaths || latest?.evidencePaths || []).length);
  const status = item.status || latest?.status || "planned";
  const blocked = ["failed"].includes(status);

  if (blocked) return { kind: "blocked", label: "阻塞", reason: item.validationNotes || latest?.summary || "任务失败或未能完成" };
  if (recommendation === "merge" && qualityScore === 100 && hasResult && hasEvidence) {
    return { kind: "merge-ready", label: "建议合并", reason: item.validationNotes || latest?.summary || "质量门槛已达 100 分" };
  }
  if (recommendation === "needs-human") {
    return { kind: "needs-human", label: "需要人工确认", reason: item.validationNotes || latest?.summary || "worker 请求人工判断" };
  }
  if (recommendation === "reject") {
    return { kind: "rejected", label: "暂不合并", reason: item.validationNotes || latest?.summary || "worker 建议搁置" };
  }
  if (["needs-polish", "codex-completed"].includes(status) || recommendation === "needs-polish" || qualityScore != null) {
    return { kind: "needs-continuation", label: "继续优化", reason: item.validationNotes || latest?.summary || "尚未达到 100 分闭环" };
  }
  return { kind: "pending", label: "等待回收", reason: item.proposal || item.finding || "等待 worker 产出" };
}

function buildRunDecisionSummary(run) {
  const buckets = {
    mergeReady: [],
    needsContinuation: [],
    needsHuman: [],
    blockers: [],
    pending: [],
    rejected: [],
  };
  for (const item of run.items || []) {
    if (item.id === "visual-quality-score") continue;
    if (!item.selected && !item.codexSessions?.some((session) => session.mode === "app-handoff")) continue;
    const decision = buildMorningDecision(item);
    const entry = {
      itemId: item.id,
      title: item.title,
      status: item.status,
      qualityScore: normalizeQualityScore(item.qualityScore),
      recommendation: normalizeRecommendation(item.mergeRecommendation || latestAppHandoffSession(item)?.recommendation),
      resultPath: item.resultPath || latestAppHandoffSession(item)?.resultPath || null,
      reason: decision.reason,
    };
    if (decision.kind === "merge-ready") buckets.mergeReady.push(entry);
    else if (decision.kind === "needs-continuation") buckets.needsContinuation.push(entry);
    else if (decision.kind === "needs-human") buckets.needsHuman.push(entry);
    else if (decision.kind === "blocked") buckets.blockers.push(entry);
    else if (decision.kind === "rejected") buckets.rejected.push(entry);
    else buckets.pending.push(entry);
  }
  return buckets;
}

function writeCoordinationPlan(run) {
  const dir = runStateDir(run.id);
  mkdirSync(dir, { recursive: true });
  const coordinationPath = join(dir, "coordination.json");
  const workers = (run.items || [])
    .filter((item) => item.codexSessions?.some((session) => session.mode === "app-handoff"))
    .map((item) => {
      const session = latestAppHandoffSession(item);
      const morningDecision = buildMorningDecision(item);
      return {
        itemId: item.id,
        title: item.title,
        role: item.agent,
        skill: item.skill,
        status: item.status,
        worktreePath: item.worktreePath,
        branch: item.branch,
        contextPath: item.contextPath,
        sessionId: session?.id || null,
        resultPath: session?.resultPath || null,
        logPath: session?.logPath || null,
        hasResult: Boolean(session?.hasResult || item.resultPath),
        qualityScore: normalizeQualityScore(item.qualityScore ?? session?.qualityScore),
        recommendation: normalizeRecommendation(item.mergeRecommendation || session?.recommendation),
        morningDecision,
        evidencePaths: item.evidencePaths || session?.evidencePaths || [],
        changedPaths: item.changedPaths || session?.changedPaths || [],
        verification: item.verification || session?.verification || null,
        nextWorkers: item.nextWorkers || session?.nextWorkers || [],
        finishedAt: session?.finishedAt || null,
        dependsOn: item.id === "visual-quality-score" ? [] : ["visual-quality-score"],
      };
    });
  const morningRecovery = buildRunDecisionSummary(run);
  const plan = {
    runId: run.id,
    targetId: run.targetId,
    targetName: run.targetName,
    productMode: run.productMode || "general",
    target: {
      appUrl: run.targetAppUrl,
      repo: run.targetRoot,
      baseBranch: run.baseBranch,
      health: run.targetHealth || null,
      nightWindow: run.nightWindow || null,
    },
    strategy: "coordinator-plus-parallel-codex-app-workers",
    coordinator: {
      name: "Steve",
      responsibilities: [
        "generate shared context",
      "spawn or register multiple Codex App handoffs",
      "decide when skill discovery is required",
      "collect reports",
      "update run state",
      "delegate final acceptance to the post-worker quality controller",
    ],
  },
  qualityController: {
    name: "Steve 总质检 agent",
    mode: "post-worker-controller",
    trigger: "after any worker writes result.md or handoff-result",
    authority: [
      "verify worker evidence before accepting recommendation",
      "mark items merge-ready only after 100-point validation",
      "create next focused worker handoffs when evidence is incomplete",
      "continue discovering new valuable work even when all current items pass",
      "refresh coordination, morning recovery, and Chinese reports",
    ],
    requiredChecks: [
      "read run-context.md and coordination.json",
      "inspect each completed worker result.md",
      "compare changedPaths with target repo/worktree status",
      "rerun relevant tests or visual scoring",
      "confirm services were restarted when UI/server code changed",
      "write a Chinese QA report and next-worker plan",
    ],
    workerRecommendationIsInputOnly: true,
    neverIdle: true,
    whenAllItemsPass: "create the next batch of high-value product, verification, or feature-discovery workers",
  },
    skillPolicy: {
      requiredDecisionBeforeWork: true,
      recordChosenSkill: true,
      recordAlternatives: true,
      allowNoSkillWithReason: true,
      triggerAreas: [
        "frontend/product polish",
        "browser or Playwright verification",
        "knowledge base and retrieval",
        "agent orchestration",
        "Slack/DingTalk/Feishu collaboration",
        "release readiness",
      ],
    },
    qualityGate: {
      targetScore: 100,
      requiredEvidence: [
        "product-flow verification",
        "visual verification",
        "regression checks",
        "Chinese why-it-matters report",
        "merge/continue/abandon recommendation",
      ],
      belowTargetAction: "create next focused worker handoff and continue optimizing",
    },
    maxParallelCodex: 4,
    sharedContextPath: run.runContextPath || null,
    visualBaseline: run.items?.find((item) => item.id === "visual-quality-score")?.visualScore || null,
    morningRecovery: {
      readyForMorning: workers.length > 0 && morningRecovery.pending.length === 0,
      decisionCounts: {
        mergeReady: morningRecovery.mergeReady.length,
        needsContinuation: morningRecovery.needsContinuation.length,
        needsHuman: morningRecovery.needsHuman.length,
        blockers: morningRecovery.blockers.length,
        pending: morningRecovery.pending.length,
        rejected: morningRecovery.rejected.length,
      },
      ...morningRecovery,
    },
    workers,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(coordinationPath, JSON.stringify(plan, null, 2), "utf-8");
  run.coordinationPath = coordinationPath;
  run.coordination = {
    strategy: plan.strategy,
    workerCount: workers.length,
    maxParallelCodex: plan.maxParallelCodex,
    updatedAt: plan.updatedAt,
  };
  return plan;
}

function refreshCoordination(run) {
  writeRunContext(run);
  const plan = writeCoordinationPlan(run);
  run.report = buildReport(run);
  saveRun(run);
  return plan;
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56) || "item";
}

function runId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").toLowerCase();
  return `steve-${stamp}-${randomBytes(2).toString("hex")}`;
}

function makeItems(target, id) {
  const basePath = join(target.worktreeDir || join(ROOT, "worktrees", target.id), id);
  const defs = [
    {
      id: "night-execution-control",
      title: "夜间执行编排与早晨回收",
      type: "optimization",
      valueScore: 98,
      risk: "medium",
      agent: "Steve coordinator agent",
      skill: "using-superpowers",
      finding: "夜间 agent 团队不只是生成候选点，还需要明确时段、目标健康、工作树隔离、早晨报告和人工合并选择。",
      proposal: "在计划里记录夜间窗口、target 健康快照、候选 worktree、验证状态和合并建议，早上只展示可决策结果。",
      checklist: ["夜间时段和目标工时可见", "target 本地地址和 git 状态可检查", "Steve 产物不混入目标产品仓库"],
      selected: true,
      recommendation: "recommended",
    },
    {
      id: "visual-quality-score",
      title: "CodeNext 视觉体验评分",
      type: "visual-score",
      valueScore: 100,
      risk: "low",
      agent: "Steve visual scoring agent",
      skill: "playwright-testing",
      finding: "苹果式丝滑首先要有稳定视觉基线：桌面和移动端不能有横向溢出、信息层级混乱、小点击目标、搜索和场景切换缺少反馈。",
      proposal: "自动打开 CodeNext 关键页面，采集截图、交互状态、控制台和网络错误，并生成 0-100 视觉体验评分。",
      checklist: ["桌面和移动端截图已采集", "核心页面无横向溢出和明显小点击目标", "视觉评分达到目标阈值", "结果回写到 Steve 报告"],
      selected: true,
      recommendation: "recommended",
      required: true,
    },
    {
      id: "product-experience-audit",
      title: "产品核心路径体验审计",
      type: "optimization",
      valueScore: 96,
      risk: "medium",
      agent: "Steve product experience agent",
      skill: "using-superpowers",
      finding: "从真实用户视角完整走首次进入、核心操作、失败恢复、继续使用和退出路径，找出不丝滑、不闭环的位置。",
      proposal: "把体验问题拆成可执行候选点，并为每个点定义验证清单、影响范围和合并建议。",
      checklist: ["能从目标 URL 进入产品", "记录每个卡顿点的触发路径", "每个优化点有可复验标准"],
      selected: true,
      recommendation: "recommended",
    },
    {
      id: "interaction-polish",
      title: "交互细节与排序展示优化",
      type: "optimization",
      valueScore: 92,
      risk: "medium",
      agent: "frontend/product polish agent",
      skill: "frontend-design",
      finding: "产品体验不只看功能可用，还要看信息排序、反馈、空态、错误态和下一步是否自然。",
      proposal: "针对高频入口做界面扫读、安装/提交/返回等动作反馈和失败提示优化。",
      checklist: ["主入口信息可扫读", "已完成和未完成状态排序合理", "错误和等待状态不让用户猜"],
      selected: true,
      recommendation: "recommended",
    },
    {
      id: "core-feature-regression",
      title: "核心功能自动化回归",
      type: "optimization",
      valueScore: 90,
      risk: "low",
      agent: "browser verification agent",
      skill: "playwright-testing",
      finding: "Steve 的结论需要真实浏览器或接口证据支撑，不能只凭静态阅读。",
      proposal: "为核心功能建立可重复的操作脚本、截图检查和接口断言。",
      checklist: ["关键路径可自动重放", "控制台无明显报错", "失败时报告能定位到页面或接口"],
      selected: true,
      recommendation: "recommended",
    },
    {
      id: "open-source-readiness",
      title: "开源准备与敏感信息检查",
      type: "optimization",
      valueScore: 88,
      risk: "high",
      agent: "release readiness agent",
      skill: "release-readiness",
      finding: "开源目标需要把产品代码、企业配置、Steve 工具产物和敏感信息边界分清楚。",
      proposal: "检查未管理文件、内部品牌、密钥、部署说明和外部用户启动路径。",
      checklist: ["不输出真实密钥或 cookie", "工具产物不混入目标产品提交", "外部用户能独立理解启动方式"],
      selected: false,
      recommendation: "evaluate",
    },
    {
      id: "new-feature-discovery",
      title: "高价值新功能发现",
      type: "feature",
      valueScore: 84,
      risk: "medium",
      agent: "Steve roadmap agent",
      skill: "skill-authoring",
      finding: "Steve 夜间工作除了修问题，也应该提出值得产品化的新功能点。",
      proposal: "把新功能点和体验修复分开记录，早上由用户选择是否进入实现。",
      checklist: ["新功能有明确用户收益", "不和当前目标冲突", "能拆成小步验证"],
      selected: false,
      recommendation: "evaluate",
    },
  ];
  return defs.map((item) => ({
    ...item,
    status: "planned",
    branch: workerBranchName(target, id, item.id),
    worktreePath: join(basePath, item.id),
    updatedAt: null,
  }));
}

function buildReport(run) {
  const slots = run.nightWindow?.slots?.join(" / ") || "未配置";
  const decisionSummary = buildRunDecisionSummary(run);
  const lines = [
    `# Steve 中文体验报告：${run.targetName}`,
    "",
    `- 目标项目：${run.targetName}`,
    `- 本地地址：${run.targetAppUrl}`,
    `- 夜间窗口：${slots}（${run.nightWindow?.timezone || "local"}，目标 ${run.nightWindow?.targetHours || "-"} 小时）`,
    `- Target 健康：${run.targetHealth?.ok ? "可执行" : "需要处理"}`,
    `- 创建时间：${run.createdAt}`,
    `- 状态：${run.status}`,
    `- 候选点：${run.items.length}`,
    `- Codex App worker：${run.coordination?.workerCount ?? 0}/${run.coordination?.maxParallelCodex ?? 4}`,
    `- 共享上下文：${run.runContextPath || "未生成"}`,
    `- 协调计划：${run.coordinationPath || "未生成"}`,
    `- 当前 Steve 工作 Codex 通知：${run.currentCodexNotification?.latestPath || "未发送"}`,
    `- Watchdog：${run.currentCodexWatchdog?.latestNudgePath ? `最近唤醒 ${run.currentCodexWatchdog.latestNudgePath}` : "未触发唤醒"}`,
    "",
    "## 早晨回收摘要",
    "",
    `- 建议合并：${decisionSummary.mergeReady.length}`,
    `- 需要继续优化：${decisionSummary.needsContinuation.length}`,
    `- 需要人工确认：${decisionSummary.needsHuman.length}`,
    `- 阻塞：${decisionSummary.blockers.length}`,
    `- 等待回收：${decisionSummary.pending.length}`,
    `- 可决策标准：只把 qualityScore=100、证据齐全、recommendation=merge 的候选点放入建议合并；不足 100 的候选点继续派生下一轮 worker。`,
    "",
    ...["mergeReady", "needsContinuation", "needsHuman", "blockers"].flatMap((key) => {
      const label = {
        mergeReady: "建议合并",
        needsContinuation: "继续优化",
        needsHuman: "人工确认",
        blockers: "阻塞",
      }[key];
      const entries = decisionSummary[key] || [];
      if (!entries.length) return [];
      return [
        `### ${label}`,
        ...entries.map((entry) => `- ${entry.title}：${entry.reason}${entry.resultPath ? "（报告已回收）" : ""}`),
        "",
      ];
    }),
    "## 候选点",
    "",
  ];
  for (const item of run.items) {
    const latest = latestAppHandoffSession(item);
    const morningDecision = buildMorningDecision(item);
    lines.push(`### ${item.title}`);
    lines.push(`- 类型：${item.type === "feature" ? "新功能" : "体验优化"}`);
    lines.push(`- 价值评分：${item.valueScore}`);
    lines.push(`- 风险：${item.risk}`);
    lines.push(`- 状态：${item.status}`);
    lines.push(`- Agent：${item.agent}`);
    lines.push(`- Skill：${item.skill}`);
    lines.push(`- 早晨决策：${morningDecision.label}（${morningDecision.reason}）`);
    if (item.qualityScore != null || latest?.qualityScore != null) {
      lines.push(`- 质量门槛：${normalizeQualityScore(item.qualityScore ?? latest?.qualityScore)}/100`);
    }
    if (item.mergeRecommendation || latest?.recommendation) {
      lines.push(`- 合并建议：${normalizeRecommendation(item.mergeRecommendation || latest?.recommendation) || item.mergeRecommendation || latest?.recommendation}`);
    }
    const evidencePaths = item.evidencePaths || latest?.evidencePaths || [];
    if (evidencePaths.length) {
      lines.push(`- 证据路径：${evidencePaths.join("；")}`);
    }
    lines.push(`- 观察：${item.finding}`);
    lines.push(`- 建议：${item.proposal}`);
    lines.push(`- 执行环境：${item.worktreePath ? "隔离工作区已准备" : "等待准备"}`);
    if (item.visualScore) {
      lines.push(`- 视觉评分：${item.visualScore.score}/${item.visualScore.maxScore || 100}（阈值 ${item.visualScore.minScore}，${item.visualScore.passed ? "通过" : "未通过"}）`);
      lines.push(`- 视觉报告：${item.visualScore.reportPath}`);
    }
    if (item.codexSessions?.length) {
      const session = item.codexSessions[item.codexSessions.length - 1];
      lines.push(`- Codex 会话：${session.status}，${session.startedAt || ""}`);
      lines.push(`- 结果文件：${session.resultPath ? "报告已回收" : "未产出"}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function createRun(targetId) {
  const target = findTarget(targetId);
  if (!target) throw new Error(`target not found: ${targetId}`);
  const id = runId();
  const run = {
    id,
    targetId: target.id,
    targetName: target.name,
    productMode: target.productMode || "general",
    targetRoot: target.root,
    targetAppUrl: target.appUrl,
    baseBranch: target.baseBranch || "main",
    gitPrivacy: gitPrivacyFor(target),
    visualScoreConfig: target.visualScore || null,
    nightWindow: target.nightWindow || null,
    targetHealth: null,
    status: "planned",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    items: makeItems(target, id),
  };
  run.report = buildReport(run);
  return saveRun(run);
}

async function createRunWithHealth(targetId) {
  const run = createRun(targetId);
  const target = findTarget(run.targetId);
  run.targetHealth = target ? await targetHealth(target) : null;
  run.report = buildReport(run);
  return saveRun(run);
}

function findRun(id) {
  return runs().find((run) => run.id === id) || null;
}

function latestRunForTarget(targetId = "codenext") {
  return runs().find((run) => run.targetId === targetId) || null;
}

function mergePlan(run) {
  const mergeableStatuses = new Set(["validated", "codex-completed"]);
  const selected = run.items.filter((item) => (
    item.selected
    && item.type !== "visual-score"
    && mergeableStatuses.has(item.status)
  ));
  const privateRefs = usesDetachedWorkerWorktrees(run);
  const planItems = selected.map((item) => {
    const head = worktreeHead(item.worktreePath);
    const ref = privateRefs ? (head || "<commit-sha>") : (item.branch || head || "<commit-sha>");
    return {
      id: item.id,
      title: item.title,
      branch: privateRefs ? null : (item.branch || null),
      commit: head || null,
      path: privateRefs ? "隔离工作区" : item.worktreePath,
      command: `git merge --no-ff ${ref}`,
    };
  });
  return {
    runId: run.id,
    targetRoot: run.targetRoot,
    baseBranch: run.baseBranch,
    selected: planItems,
    commands: [
      `cd ${run.targetRoot}`,
      `git checkout ${run.baseBranch}`,
      ...planItems.map((item) => item.command),
    ],
  };
}

function createWorktree(run, itemId) {
  const item = run.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error("item not found");
  if (!run.targetRoot || !existsSync(run.targetRoot)) throw new Error("target root not found");
  if (isInside(run.targetRoot, item.worktreePath)) {
    throw new Error("Steve worktree path must stay outside target repository");
  }
  const git = gitOk(run.targetRoot);
  if (!git.ok) throw new Error(git.message);
  mkdirSync(dirname(item.worktreePath), { recursive: true });
  if (!existsSync(item.worktreePath)) {
    const detached = usesDetachedWorkerWorktrees(run);
    let result = detached
      ? spawnSync("git", ["worktree", "add", "--detach", item.worktreePath, run.baseBranch], {
        cwd: run.targetRoot,
        encoding: "utf-8",
      })
      : spawnSync("git", ["worktree", "add", "-b", item.branch, item.worktreePath, run.baseBranch], {
      cwd: run.targetRoot,
      encoding: "utf-8",
    });
    if (result.status !== 0 && /already exists/i.test(`${result.stderr}\n${result.stdout}`)) {
      result = detached
        ? spawnSync("git", ["worktree", "add", "--detach", item.worktreePath, run.baseBranch], {
          cwd: run.targetRoot,
          encoding: "utf-8",
        })
        : spawnSync("git", ["worktree", "add", item.worktreePath, item.branch], {
        cwd: run.targetRoot,
        encoding: "utf-8",
      });
    }
    if (result.status !== 0) {
      throw new Error(String(result.stderr || result.stdout || "git worktree failed").slice(0, 1200));
    }
  }
  item.status = item.status === "planned" ? "worktree-ready" : item.status;
  item.updatedAt = new Date().toISOString();
  item.contextPath = item.contextPath || writeContextPack(run, item).contextPath;
  run.updatedAt = item.updatedAt;
  run.report = buildReport(run);
  saveRun(run);
  refreshCoordination(run);
  return item;
}

function registerFocusedItem(run, input = {}) {
  const id = slug(input.id || input.title || input.name);
  if (!id) throw new Error("item id required");
  if (run.items.some((item) => item.id === id)) {
    throw new Error(`item already exists: ${id}`);
  }
  const now = new Date().toISOString();
  const itemDir = itemStateDir(run.id, id);
  mkdirSync(itemDir, { recursive: true });
  const resultPath = input.resultPath || join(itemDir, "result.md");
  const contextPath = input.contextPath || join(itemDir, "context.md");
  const logPath = input.logPath || join(itemDir, "codex.jsonl");
  const target = findTarget(run.targetId);
  const worktreeBase = target?.worktreeDir || join(ROOT, "worktrees", run.targetId);
  const branch = usesDetachedWorkerWorktrees(run) ? null : (input.branch || workerBranchName(target || run, run.id, id));
  const item = {
    id,
    title: input.title || id,
    type: input.type || "optimization",
    valueScore: Number(input.valueScore) || 90,
    risk: input.risk || "medium",
    agent: input.agent || "focused Codex worker",
    skill: input.skill || "auto-discovered",
    finding: input.finding || "由总质检 agent 派生的 focused worker。",
    proposal: input.proposal || "完成一个具体产品优化点并回写 result.md。",
    checklist: Array.isArray(input.checklist) ? input.checklist : [
      "写入中文 result.md",
      "记录 skill 使用判断",
      "提供测试或视觉证据",
      "给出 100 分质量门槛自评",
    ],
    selected: input.selected !== false,
    recommendation: input.recommendation || "recommended",
    status: input.status || (existsSync(resultPath) ? "codex-completed" : "handoff-ready"),
    branch,
    worktreePath: input.worktreePath || join(worktreeBase, run.id, id),
    contextPath,
    resultPath,
    updatedAt: now,
    codexSessions: [{
      id: input.sessionId || `codex-${Date.now()}-${randomBytes(2).toString("hex")}`,
      status: existsSync(resultPath) ? "completed" : "handoff-ready",
      mode: "app-handoff",
      executor: "codex-app",
      codexBin: null,
      cwd: input.worktreePath || join(worktreeBase, run.id, id),
      contextPath,
      resultPath,
      logPath,
      startedAt: input.startedAt || now,
      finishedAt: existsSync(resultPath) ? now : null,
      exitCode: null,
      error: null,
      hasResult: existsSync(resultPath),
    }],
  };
  if (!existsSync(contextPath)) {
    writeFileSync(contextPath, [
      `# Steve Focused Handoff: ${item.title}`,
      "",
      `- Run: ${run.id}`,
      `- Target: ${run.targetName}`,
      `- Worktree: ${item.worktreePath}`,
      `- Result: ${item.resultPath}`,
      `- Git privacy: ${usesDetachedWorkerWorktrees(run) ? "detached worktree; do not create public worker branches" : "named branch mode"}`,
      "",
      "这个 focused worker 由总质检 agent 派生。完成后必须交回总质检复核；worker 自评不能直接作为最终完成。",
      "",
      "提交与对外信息规则：CodeNext 提交、PR 标题、变更说明和用户可见文案只能描述产品改动；不要写 Steve、run id、worker id、worktree 路径、内部验证链路、用户原话需求或私有上下文。",
    ].join("\n"), "utf-8");
  }
  run.items.push(item);
  run.updatedAt = now;
  refreshCoordination(run);
  return item;
}

function codexExecutorStatus() {
  if (CODEX_EXECUTOR_MODE !== "cli") {
    return {
      ok: true,
      mode: "app-handoff",
      message: "使用当前 Codex App 接管任务：Steve 生成 handoff/context，等待 App 会话派生与回收",
      bin: null,
    };
  }
  if (!CODEX_BIN || !existsSync(CODEX_BIN)) {
    return { ok: false, mode: "cli", message: `Codex CLI 不存在：${CODEX_BIN}` };
  }
  const result = spawnSync(CODEX_BIN, ["--version"], { encoding: "utf-8", timeout: 3000 });
  return {
    ok: result.status === 0,
    mode: "cli",
    message: result.status === 0 ? (result.stdout || "Codex CLI 可用").trim() : (result.stderr || "Codex CLI 不可用").trim(),
    bin: CODEX_BIN,
  };
}

function writeContextPack(run, item) {
  const dir = itemStateDir(run.id, item.id);
  mkdirSync(dir, { recursive: true });
  const contextPath = join(dir, "context.md");
  const resultPath = join(dir, "result.md");
  const logPath = join(dir, "codex.jsonl");
  const prompt = [
    `# Steve Handoff: ${item.title}`,
    "",
    "你是 Steve 派生出来的 Codex worker，会在独立 worktree 内完成一个产品体验优化点。",
    item.id === "night-execution-control"
      ? "你的责任范围是 Steve 夜间执行编排与早晨回收：优先改进 Steve 协议、报告、看板和状态记录；只有 item 明确需要时才改目标产品代码。"
      : "你的责任范围以本候选点为准；不要覆盖其他 worker 的 worktree 或结论。",
    "",
    "## 父级上下文",
    "",
    `- Steve run: ${run.id}`,
    `- Target: ${run.targetName}`,
    `- Product mode: ${run.productMode || "general"}`,
    `- Target app URL: ${run.targetAppUrl}`,
    `- Target repo: ${run.targetRoot}`,
    `- Base branch: ${run.baseBranch}`,
    `- Worktree: ${item.worktreePath}`,
    `- Branch: ${item.branch || "detached worktree，不创建面向协作者可见的 worker 分支"}`,
    `- Git privacy: ${usesDetachedWorkerWorktrees(run) ? "不要创建 steve/*、run id、worker id 等可见 Git refs；提交信息只写产品改动。" : "named branch mode"}`,
    `- Night window: ${(run.nightWindow?.slots || []).join(" / ") || "未配置"} ${run.nightWindow?.timezone || ""}`,
    `- Shared run context: ${run.runContextPath || join(runStateDir(run.id), "run-context.md")}`,
    `- Coordination plan: ${run.coordinationPath || join(runStateDir(run.id), "coordination.json")}`,
    "",
    "## 候选点",
    "",
    `- 类型: ${item.type}`,
    `- 价值评分: ${item.valueScore}`,
    `- 风险: ${item.risk}`,
    `- 建议 skill: ${item.skill}`,
    `- Steve 观察: ${item.finding}`,
    `- 建议动作: ${item.proposal}`,
    "",
    "## Skill 使用决策",
    "",
    "- 开工前先判断这个任务是否需要 skill 加持。",
    "- 如果需要：发现或选择最合适的 skill，并记录候选 skill、最终选择、为什么它能提升任务精准度。",
    "- 如果不需要：写清楚不使用 skill 的原因。",
    "- 涉及知识库、agent 编排、Slack/钉钉/飞书、多 agent、前端体验、Playwright 验证或发布检查时，默认需要主动做 skill 发现。",
    "",
    "## 验证清单",
    "",
    ...(item.checklist || []).map((line) => `- ${line}`),
    "- Skill 使用判断已记录",
    "- 100 分质量门槛已自评：产品路径、视觉体验、回归验证、中文说明、合并建议",
    "",
    "## 工作规则",
    "",
    "- 你不是孤立工作：不要改动 Steve 项目自身，除非任务明确要求。",
    "- 你属于一个多 Codex App worker 团队；先阅读 Shared run context，理解其他 worker 的职责。",
    "- 只在当前 worktree 中完成这个候选点，避免影响其他 worker。",
    "- 不要泄露密钥、cookie、token 或线上私有配置。",
    "- 如果 target 是 enterprise，不要因为出现企业集成能力就直接删除；优先检查默认文案、边界说明和降级体验。",
    "- CodeNext 产品仓库面向协作者：提交信息、分支名、PR 标题、README、用户可见文案都不能暴露 Steve 驱动细节、run id、worker id、worktree 路径、用户原话需求或内部验证链路。",
    "- 如果需要提交 CodeNext 代码，提交标题必须是产品视角，例如 `fix: improve skill hub layout`；不要写 `steve/codenext/...`、`night worker`、`user asked`、`Steve validation` 等内部信息。",
    "- 如果发现这个候选点不值得做，说明原因并停止，不要硬改。",
    "- 不能把“做了”当成“完成”：低于 100 分时要给出下一轮 worker 建议，并把任务保持为需要继续优化。",
    "- 完成后必须用中文总结：做了什么、验证了什么、风险是什么、是否建议合并。",
    "",
    "## 期望输出",
    "",
    "请最终输出一个中文报告，包含：",
    "- 结论：建议合并 / 暂不合并 / 需要人工确认",
    "- 改动摘要",
    "- Skill 使用判断",
    "- 100 分质量门槛自评和扣分点",
    "- 验证结果",
    "- 剩余风险",
    "- 后续建议",
    "- 上下文回收：报告路径、是否依赖其他 worker、建议 Steve 下一轮派生任务",
    "",
    "如果通过 endpoint 回收，建议 body 使用：",
    "```json",
    JSON.stringify({
      summary: "中文一句话结论",
      report: "# 中文报告...",
      recommendation: "merge | needs-polish | needs-human | reject",
      qualityScore: 100,
      evidencePaths: ["证据文件或报告路径"],
      changedPaths: ["改动路径"],
      verification: {
        productFlow: "已验证/不适用及原因",
        visual: "已验证/不适用及原因",
        regression: "已验证/不适用及原因",
      },
      nextWorkers: ["低于 100 分时建议的下一轮 worker"],
      dependsOn: ["visual-quality-score"],
    }, null, 2),
    "```",
  ].join("\n");
  writeFileSync(contextPath, prompt, "utf-8");
  return { contextPath, resultPath, logPath, prompt };
}

function startCodexSession(run, itemId, options = {}) {
  const item = createWorktree(run, itemId);
  const executor = codexExecutorStatus();
  const useCli = options.executor === "cli" || (options.executor == null && CODEX_EXECUTOR_MODE === "cli" && !options.dryRun);
  const availability = useCli ? executor : { ...executor, ok: true };
  if (!availability.ok) throw new Error(availability.message);

  const { contextPath, resultPath, logPath, prompt } = writeContextPack(run, item);
  const session = {
    id: `codex-${Date.now()}-${randomBytes(2).toString("hex")}`,
    status: useCli ? "running" : (options.dryRun ? "context-ready" : "handoff-ready"),
    mode: useCli ? "cli-exec" : (options.dryRun ? "context-pack" : "app-handoff"),
    executor: useCli ? "cli" : "codex-app",
    codexBin: useCli ? CODEX_BIN : null,
    cwd: item.worktreePath,
    contextPath,
    resultPath,
    logPath,
    startedAt: new Date().toISOString(),
    exitCode: null,
    error: null,
  };
  item.codexSessions = [...(item.codexSessions || []), session];
  item.status = useCli ? "in-progress" : (options.dryRun ? "context-ready" : "handoff-ready");
  item.contextPath = contextPath;
  item.updatedAt = new Date().toISOString();
  run.updatedAt = item.updatedAt;
  run.report = buildReport(run);
  saveRun(run);
  refreshCoordination(run);

  if (!useCli) return session;

  writeFileSync(logPath, "", "utf-8");
  const child = spawn(CODEX_BIN, [
    "exec",
    "--json",
    "-C", item.worktreePath,
    "-s", options.sandbox || "workspace-write",
    "-o", resultPath,
    "-",
  ], {
    cwd: item.worktreePath,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  child.stdin.write(prompt);
  child.stdin.end();
  child.stdout.on("data", (chunk) => appendFileSync(logPath, chunk));
  child.stderr.on("data", (chunk) => appendFileSync(logPath, chunk));
  child.on("error", (err) => {
    const latest = findRun(run.id);
    const targetItem = latest?.items.find((candidate) => candidate.id === item.id);
    const targetSession = targetItem?.codexSessions?.find((entry) => entry.id === session.id);
    if (targetSession) {
      targetSession.status = "failed";
      targetSession.error = err.message;
      targetItem.status = "failed";
      targetItem.updatedAt = new Date().toISOString();
      latest.updatedAt = targetItem.updatedAt;
      latest.report = buildReport(latest);
      saveRun(latest);
      refreshCoordination(latest);
    }
  });
  child.on("close", (code) => {
    const latest = findRun(run.id);
    const targetItem = latest?.items.find((candidate) => candidate.id === item.id);
    const targetSession = targetItem?.codexSessions?.find((entry) => entry.id === session.id);
    if (targetSession) {
      targetSession.status = code === 0 ? "completed" : "failed";
      targetSession.exitCode = code;
      targetSession.finishedAt = new Date().toISOString();
      targetSession.hasResult = existsSync(resultPath);
      targetItem.status = code === 0 ? "codex-completed" : "failed";
      targetItem.updatedAt = targetSession.finishedAt;
      latest.updatedAt = targetSession.finishedAt;
      latest.report = buildReport(latest);
      saveRun(latest);
      refreshCoordination(latest);
    }
  });
  session.pid = child.pid;
  saveRun(run);
  refreshCoordination(run);
  return session;
}

function recordHandoffResult(run, itemId, result = {}) {
  const item = run.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error("item not found");
  const latestSession = latestAppHandoffSession(item);
  const finishedAt = new Date().toISOString();
  const resultText = result.report == null ? "" : String(result.report).trim();
  const resultPath = result.resultPath || latestSession?.resultPath || join(itemStateDir(run.id, item.id), "result.md");
  const qualityScore = normalizeQualityScore(result.qualityScore ?? result.qualityGate?.score);
  const recommendation = normalizeRecommendation(result.recommendation || result.mergeRecommendation);

  if (resultText) {
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, resultText, "utf-8");
  }

  if (latestSession) {
    latestSession.status = result.status || "completed";
    latestSession.finishedAt = finishedAt;
    latestSession.hasResult = existsSync(resultPath);
    latestSession.resultPath = resultPath;
    latestSession.summary = result.summary || null;
    latestSession.recommendation = recommendation || result.recommendation || null;
    latestSession.qualityScore = qualityScore;
    latestSession.evidencePaths = Array.isArray(result.evidencePaths) ? result.evidencePaths : [];
    latestSession.changedPaths = Array.isArray(result.changedPaths) ? result.changedPaths : [];
    latestSession.verification = result.verification || null;
    latestSession.qualityGate = result.qualityGate || null;
    latestSession.dependsOn = result.dependsOn || [];
    latestSession.nextWorkers = result.nextWorkers || [];
  }

  item.qualityScore = qualityScore ?? item.qualityScore ?? null;
  item.mergeRecommendation = recommendation || result.recommendation || item.mergeRecommendation || null;
  item.evidencePaths = Array.isArray(result.evidencePaths) ? result.evidencePaths : (item.evidencePaths || []);
  item.changedPaths = Array.isArray(result.changedPaths) ? result.changedPaths : (item.changedPaths || []);
  item.verification = result.verification || item.verification || null;
  item.qualityGate = result.qualityGate || item.qualityGate || null;
  item.status = result.itemStatus
    || (recommendation === "needs-polish" ? "needs-polish" : null)
    || (recommendation === "needs-human" ? "needs-polish" : null)
    || (recommendation === "reject" ? "rejected" : null)
    || (qualityScore != null && qualityScore < 100 ? "needs-polish" : null)
    || "codex-completed";
  item.validationNotes = result.summary || result.validationNotes || item.validationNotes || "";
  item.resultPath = resultPath;
  item.dependsOn = result.dependsOn || item.dependsOn || [];
  item.nextWorkers = result.nextWorkers || [];
  item.updatedAt = finishedAt;
  run.updatedAt = finishedAt;
  refreshCoordination(run);
  return item;
}

function reportSummary(text) {
  const lines = String(text || "").split(/\r?\n/);
  const conclusionIndex = lines.findIndex((line) => /^##\s+结论/.test(line.trim()));
  const candidates = conclusionIndex >= 0 ? lines.slice(conclusionIndex + 1) : lines;
  return candidates
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("- ")) || "";
}

function reportQualityScore(text) {
  const focused = String(text || "").match(/当前(?:自评|评分|质量门槛)[：:\s]*(\d{1,3})\s*\/\s*100/);
  if (focused) return normalizeQualityScore(focused[1]);
  const matches = [...String(text || "").matchAll(/(\d{1,3})\s*\/\s*100/g)];
  if (!matches.length) return null;
  return normalizeQualityScore(matches[matches.length - 1][1]);
}

function reportRecommendation(text, qualityScore) {
  const sample = String(text || "").slice(0, 2000);
  if (/建议合并/.test(sample)) return "merge";
  if (/需要人工确认/.test(sample)) return "needs-human";
  if (/暂不合并|继续优化|继续派生/.test(sample)) return "needs-polish";
  return qualityScore != null && qualityScore < 100 ? "needs-polish" : null;
}

function shouldIngestResult(item, session, force) {
  if (force) return true;
  if (!session?.hasResult) return true;
  if (!item.resultPath) return true;
  return ["handoff-ready", "context-ready", "in-progress"].includes(item.status);
}

function reportTitle(text, fallback) {
  const heading = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#\s+/.test(line));
  return heading
    ? heading.replace(/^#+\s*/, "").replace(/\s*(结果报告|结果)\s*$/, "").trim()
    : fallback;
}

function discoverUnregisteredResultFiles(run) {
  const dir = runStateDir(run.id);
  if (!existsSync(dir)) return [];
  const known = new Set((run.items || []).map((item) => item.id));
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !known.has(entry.name))
    .map((entry) => {
      const resultPath = join(dir, entry.name, "result.md");
      if (!existsSync(resultPath)) return null;
      const report = readFileSync(resultPath, "utf-8");
      const target = findTarget(run.targetId);
      const worktreeBase = target?.worktreeDir || join(ROOT, "worktrees", run.targetId);
      const worktreePath = join(worktreeBase, run.id, entry.name);
      return {
        id: entry.name,
        title: reportTitle(report, entry.name),
        resultPath,
        worktreePath: existsSync(worktreePath) ? worktreePath : undefined,
        status: "codex-completed",
        finding: "Steve 发现该 focused worker 已产出 result.md，但尚未登记到当前 run 状态图。",
        proposal: "自动登记并回收结果，交由总质检按 100 分质量门槛继续判断。",
      };
    })
    .filter(Boolean);
}

function registerUnregisteredResultFiles(run) {
  const registered = [];
  for (const candidate of discoverUnregisteredResultFiles(run)) {
    const item = registerFocusedItem(run, candidate);
    registered.push({
      itemId: item.id,
      title: item.title,
      resultPath: item.resultPath,
      worktreePath: item.worktreePath,
    });
  }
  return registered;
}

function ingestResultFiles(run, options = {}) {
  const registered = options.registerUntracked === false
    ? []
    : registerUnregisteredResultFiles(run);
  const ingested = [];
  for (const item of run.items || []) {
    const session = latestAppHandoffSession(item);
    if (!session?.resultPath || !existsSync(session.resultPath)) continue;
    if (!shouldIngestResult(item, session, options.force)) continue;
    const report = readFileSync(session.resultPath, "utf-8");
    if (!report.trim()) continue;
    const qualityScore = reportQualityScore(report);
    const recommendation = reportRecommendation(report, qualityScore);
    const updated = recordHandoffResult(run, item.id, {
      summary: reportSummary(report),
      recommendation,
      qualityScore,
      resultPath: session.resultPath,
      evidencePaths: [session.resultPath],
      changedPaths: [],
      verification: null,
      nextWorkers: [],
      dependsOn: item.dependsOn || ["visual-quality-score"],
    });
    ingested.push({
      itemId: item.id,
      status: updated.status,
      qualityScore: updated.qualityScore,
      recommendation: updated.mergeRecommendation,
      resultPath: updated.resultPath,
    });
  }
  if (!ingested.length && options.refresh !== false) refreshCoordination(run);
  return {
    runId: run.id,
    registeredCount: registered.length,
    registered,
    ingestedCount: ingested.length,
    ingested,
  };
}

function timeMs(value) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function fileTimeMs(file) {
  try {
    return existsSync(file) ? statSync(file).mtimeMs : 0;
  } catch {
    return 0;
  }
}

function currentCodexActivity(run) {
  const latestNotification = readJson(join(currentCodexDir(), "latest-notification.json"), null);
  const restartRequest = readJson(join(currentCodexDir(), "restart-request.json"), null);
  const pendingStatuses = new Set(["handoff-ready", "needs-polish", "context-ready", "in-progress"]);
  const pendingItems = (run.items || [])
    .filter((item) => pendingStatuses.has(item.status))
    .map((item) => {
      const latestSession = item.codexSessions?.[item.codexSessions.length - 1] || null;
      const resultPath = item.resultPath || latestSession?.resultPath || null;
      const resultMtime = resultPath ? fileTimeMs(resultPath) : 0;
      const sessionTimes = (item.codexSessions || []).flatMap((session) => [
        timeMs(session.startedAt),
        timeMs(session.finishedAt),
      ]);
      const lastActivityMs = Math.max(
        timeMs(item.updatedAt),
        resultMtime,
        ...sessionTimes,
      );
      return {
        itemId: item.id,
        title: item.title,
        status: item.status,
        contextPath: item.contextPath || latestSession?.contextPath || null,
        resultPath,
        resultExists: resultPath ? existsSync(resultPath) : false,
        lastActivityAt: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
        lastActivityMs,
      };
    });
  const lastRunActivityMs = Math.max(
    timeMs(run.updatedAt),
    timeMs(run.createdAt),
    ...pendingItems.map((item) => item.lastActivityMs),
  );
  const notificationMs = timeMs(latestNotification?.createdAt || run.currentCodexNotification?.notifiedAt);
  const lastNudge = readJson(join(currentCodexDir(), "latest-nudge.json"), null);
  return {
    runId: run.id,
    runStatus: run.status,
    latestNotification,
    restartRequest,
    pendingItems,
    lastRunActivityAt: lastRunActivityMs ? new Date(lastRunActivityMs).toISOString() : null,
    lastRunActivityMs,
    notificationAt: notificationMs ? new Date(notificationMs).toISOString() : null,
    notificationMs,
    lastNudge,
  };
}

function nudgeCurrentCodex(run, assessment, options = {}) {
  const dir = currentCodexDir();
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const nowIso = now.toISOString();
  const nudge = {
    id: `nudge-${Date.now()}-${randomBytes(2).toString("hex")}`,
    type: "steve-work-codex-watchdog-nudge",
    status: "pending",
    runId: run.id,
    targetId: run.targetId,
    targetName: run.targetName,
    createdAt: nowIso,
    reason: assessment.reason,
    idleMs: assessment.idleMs,
    idleMinutes: Math.round((assessment.idleMs / 60_000) * 10) / 10,
    action: options.action || "resume-current-steve-work-codex",
    runContextPath: run.runContextPath || null,
    coordinationPath: run.coordinationPath || null,
    restartRequestPath: join(dir, "restart-request.json"),
    pendingItems: assessment.pendingItems,
    message: [
      "Steve watchdog 发现当前工作停住了。",
      "请立即重新读取 run-context.md 和 coordination.json，从 pending item 里挑最高价值任务继续。",
      "不要等待人工确认；如果任务仍低于 100 分，产出下一轮 worker 建议并回写 result.md。",
    ],
  };
  const latestPath = join(dir, "latest-nudge.json");
  const markdownPath = join(dir, "latest-nudge.md");
  const nudgesPath = join(dir, "nudges.jsonl");
  writeFileSync(latestPath, `${JSON.stringify(nudge, null, 2)}\n`, "utf-8");
  appendFileSync(nudgesPath, `${JSON.stringify(nudge)}\n`, "utf-8");
  writeFileSync(markdownPath, [
    "# Steve Watchdog Nudge",
    "",
    `- Run: ${run.id}`,
    `- Target: ${run.targetName}`,
    `- Idle: ${nudge.idleMinutes} minutes`,
    `- Reason: ${assessment.reason}`,
    `- Run context: ${nudge.runContextPath || "未生成"}`,
    `- Coordination: ${nudge.coordinationPath || "未生成"}`,
    "",
    "## 继续执行",
    "",
    ...nudge.message.map((line) => `- ${line}`),
    "",
    "## Pending Items",
    "",
    ...(nudge.pendingItems.length
      ? nudge.pendingItems.map((item) => `- ${item.title}（${item.itemId}，${item.status}）：${item.contextPath || "no context"}`)
      : ["- 没有 pending item；请让 Steve 创建下一轮 run。"]),
    "",
  ].join("\n"), "utf-8");

  const notification = notifyCurrentCodex(run, {
    reason: `Watchdog nudge: ${assessment.reason}`,
    reportPath: options.reportPath,
  });
  const latest = findRun(run.id) || run;
  latest.currentCodexWatchdog = {
    lastCheckedAt: nowIso,
    lastNudgeAt: nowIso,
    latestNudgePath: latestPath,
    latestNudgeMarkdownPath: markdownPath,
    nudgesPath,
    nudgeId: nudge.id,
    notificationId: notification.id,
    idleMs: assessment.idleMs,
    pendingItemCount: assessment.pendingItems.length,
  };
  latest.updatedAt = nowIso;
  latest.report = buildReport(latest);
  saveRun(latest);
  return { nudge, notification, run: latest };
}

async function monitorCurrentCodex(options = {}) {
  const targetId = options.targetId || "codenext";
  const idleMs = Number(options.idleMs ?? 10 * 60_000);
  let run = options.runId ? findRun(options.runId) : latestRunForTarget(targetId);
  if (!run && options.autoRunIfMissing) {
    run = await autoRunTarget(targetId, {
      notificationReason: "Watchdog found no current run; created a new Steve run.",
    });
  }
  if (!run) {
    return {
      ok: false,
      action: "none",
      reason: `没有找到 target ${targetId} 的 Steve run`,
    };
  }

  const activity = currentCodexActivity(run);
  const nowMs = Date.now();
  const pendingItems = activity.pendingItems;
  const pendingSinceMs = Math.max(activity.notificationMs, activity.lastRunActivityMs, timeMs(run.createdAt));
  const idleAgeMs = pendingSinceMs ? nowMs - pendingSinceMs : 0;
  const hasPendingWork = pendingItems.length > 0 && ["running", "planned"].includes(run.status);
  const shouldNudge = hasPendingWork && idleAgeMs >= idleMs;
  const assessment = {
    ok: true,
    runId: run.id,
    targetId: run.targetId,
    action: shouldNudge ? "nudge" : "observe",
    reason: shouldNudge
      ? `当前 Steve 工作 Codex 已 ${Math.round(idleAgeMs / 60_000)} 分钟没有推进 pending 任务`
      : "当前未达到 watchdog nudge 阈值",
    idleMs: idleAgeMs,
    thresholdMs: idleMs,
    pendingItems,
    activity,
  };

  if (!shouldNudge) {
    run.currentCodexWatchdog = {
      ...(run.currentCodexWatchdog || {}),
      lastCheckedAt: new Date().toISOString(),
      lastObservation: assessment.reason,
      pendingItemCount: pendingItems.length,
    };
    saveRun(run);
    return assessment;
  }

  const nudgeResult = nudgeCurrentCodex(run, assessment, options);
  if (options.autoRunOnStall) {
    const rerun = await autoRunTarget(targetId, {
      notificationReason: "Watchdog detected stalled work; restarted Steve auto-run.",
    });
    return {
      ...assessment,
      nudge: nudgeResult.nudge,
      notification: nudgeResult.notification,
      restartedRunId: rerun.id,
    };
  }
  return {
    ...assessment,
    nudge: nudgeResult.nudge,
    notification: nudgeResult.notification,
  };
}

function ensureCodeNextCookie(target) {
  const visual = target.visualScore || {};
  if (!visual.cookieJar || !visual.username || !visual.password) return null;
  const loginUrl = new URL("/api/login", target.appUrl).toString();
  const payload = JSON.stringify({ username: visual.username, password: visual.password });
  const result = spawnSync("curl", [
    "--noproxy", "127.0.0.1,localhost",
    "-fsS",
    "-c", visual.cookieJar,
    "-H", "Content-Type: application/json",
    "-d", payload,
    loginUrl,
  ], { encoding: "utf-8", timeout: 6000 });
  if (result.status !== 0) {
    throw new Error(`创建 CodeNext 登录 cookie 失败：${result.stderr || result.stdout}`);
  }
  return visual.cookieJar;
}

function runVisualScore(run) {
  const target = findTarget(run.targetId);
  const visual = target?.visualScore;
  const item = run.items.find((candidate) => candidate.id === "visual-quality-score");
  if (!target || !visual?.enabled || !item) return null;
  if (!visual.script || !existsSync(visual.script)) throw new Error("视觉评分脚本不存在");
  if (!visual.config || !existsSync(visual.config)) throw new Error("视觉评分配置不存在");

  const outDir = join(ROOT, "artifacts", run.targetId, run.id, "visual-score");
  mkdirSync(outDir, { recursive: true });
  const cookieJar = ensureCodeNextCookie(target) || visual.cookieJar || "";
  const args = [
    visual.script,
    "visual",
    "--config", visual.config,
    "--visual", visual.visual || "skillhub",
    "--url", run.targetAppUrl,
    "--out", outDir,
  ];
  if (cookieJar) args.push("--cookie-jar", cookieJar);

  const startedAt = new Date().toISOString();
  const nodeBin = visual.nodeBin && existsSync(visual.nodeBin) ? visual.nodeBin : process.execPath;
  const result = spawnSync(nodeBin, args, {
    cwd: dirname(visual.script),
    encoding: "utf-8",
    timeout: Number(visual.timeoutMs) || 60_000,
    env: { ...process.env },
  });
  const finishedAt = new Date().toISOString();
  const stdoutPath = join(outDir, "stdout.log");
  const stderrPath = join(outDir, "stderr.log");
  writeFileSync(stdoutPath, result.stdout || "", "utf-8");
  writeFileSync(stderrPath, result.stderr || "", "utf-8");

  let reportJson = null;
  const reportJsonPath = join(outDir, "report.json");
  if (existsSync(reportJsonPath)) {
    reportJson = JSON.parse(readFileSync(reportJsonPath, "utf-8"));
  }
  const score = reportJson?.score?.score ?? null;
  const minScore = reportJson?.visual?.minScore ?? visual.minScore ?? 92;
  item.visualScore = {
    adapter: visual.adapter || "external",
    status: result.status === 0 ? "completed" : "failed",
    score,
    maxScore: 100,
    minScore,
    passed: typeof score === "number" ? score >= minScore : false,
    issueCount: reportJson?.score?.issues?.length || 0,
    outDir,
    reportPath: join(outDir, "report.md"),
    reportJsonPath,
    stdoutPath,
    stderrPath,
    startedAt,
    finishedAt,
    exitCode: result.status,
    nodeBin,
  };
  item.status = item.visualScore.passed ? "validated" : "needs-polish";
  item.updatedAt = finishedAt;
  run.updatedAt = finishedAt;
  run.report = buildReport(run);
  saveRun(run);
  return item.visualScore;
}

async function autoRunTarget(targetId, options = {}) {
  const run = await createRunWithHealth(targetId);
  for (const item of run.items) {
    if (item.id === "visual-quality-score") continue;
    if (item.selected || item.required) {
      try {
        startCodexSession(run, item.id, { executor: "app-handoff" });
      } catch (err) {
        const latest = findRun(run.id) || run;
        const failedItem = latest.items.find((candidate) => candidate.id === item.id);
        if (failedItem) {
          failedItem.status = "failed";
          failedItem.validationNotes = `App handoff 准备失败：${err.message || err}`;
          failedItem.updatedAt = new Date().toISOString();
          latest.updatedAt = failedItem.updatedAt;
          latest.report = buildReport(latest);
          saveRun(latest);
        }
      }
    }
  }
  const afterHandoff = findRun(run.id) || run;
  try {
    if (afterHandoff.targetHealth?.app?.ok) {
      runVisualScore(afterHandoff);
    } else {
      const visualItem = afterHandoff.items.find((candidate) => candidate.id === "visual-quality-score");
      if (visualItem) {
        const updatedAt = new Date().toISOString();
        visualItem.status = "needs-polish";
        visualItem.visualScore = {
          adapter: afterHandoff.visualScoreConfig?.adapter || "external",
          status: "skipped",
          score: null,
          maxScore: 100,
          minScore: afterHandoff.visualScoreConfig?.minScore || 92,
          passed: false,
          issueCount: 1,
          reason: afterHandoff.targetHealth?.app?.message || "target app is not reachable",
          startedAt: updatedAt,
          finishedAt: updatedAt,
          exitCode: null,
        };
        visualItem.updatedAt = updatedAt;
        afterHandoff.updatedAt = updatedAt;
        afterHandoff.report = buildReport(afterHandoff);
        saveRun(afterHandoff);
      }
    }
  } catch (err) {
    const latest = findRun(run.id) || afterHandoff;
    const visualItem = latest.items.find((candidate) => candidate.id === "visual-quality-score");
    if (visualItem) {
      const updatedAt = new Date().toISOString();
      visualItem.status = "needs-polish";
      visualItem.visualScore = {
        adapter: latest.visualScoreConfig?.adapter || "external",
        status: "failed",
        score: null,
        maxScore: 100,
        minScore: latest.visualScoreConfig?.minScore || 92,
        passed: false,
        issueCount: 1,
        reason: err.message || String(err),
        startedAt: updatedAt,
        finishedAt: updatedAt,
        exitCode: null,
      };
      visualItem.updatedAt = updatedAt;
      latest.updatedAt = updatedAt;
      latest.report = buildReport(latest);
      saveRun(latest);
    }
  }
  const latest = findRun(run.id) || run;
  latest.status = latest.targetHealth?.ok && latest.items.some((item) => item.status === "handoff-ready")
    ? "running"
    : "blocked";
  latest.updatedAt = new Date().toISOString();
  latest.report = buildReport(latest);
  saveRun(latest);
  refreshCoordination(latest);
  if (options.notifyCurrentCodex !== false) {
    notifyCurrentCodex(latest, {
      reason: options.notificationReason,
      reportPath: options.reportPath,
    });
    refreshCoordination(findRun(latest.id) || latest);
  }
  return findRun(latest.id) || latest;
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(res, status, data, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
}

function staticFile(pathname, res) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const publicRoot = resolve(ROOT, "public");
  const file = resolve(publicRoot, rel);
  if (file !== publicRoot && !file.startsWith(`${publicRoot}${sep}`)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) return false;
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  send(res, 200, readFileSync(file), types[extname(file)] || "application/octet-stream");
  return true;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/targets") return send(res, 200, { targets: await targetSummaries() });
    if (req.method === "GET" && url.pathname === "/api/runs") return send(res, 200, { runs: displayRuns() });
    if (req.method === "POST" && url.pathname === "/api/runs") {
      const body = await readBody(req);
      return send(res, 200, { ok: true, run: sanitizeRunForDisplay(await createRunWithHealth(body.targetId || "codenext")) });
    }
    if (req.method === "POST" && url.pathname === "/api/auto-run") {
      const body = await readBody(req);
      const run = await autoRunTarget(body.targetId || "codenext");
      return send(res, 200, { ok: true, run: sanitizeRunForDisplay(run), mergePlan: mergePlan(run) });
    }
    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      const run = findRun(runMatch[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      return send(res, 200, { run: sanitizeRunForDisplay(run), mergePlan: mergePlan(run) });
    }
    const coordinationMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/coordination$/);
    if (req.method === "GET" && coordinationMatch) {
      const run = findRun(coordinationMatch[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      const plan = refreshCoordination(run);
      return send(res, 200, { ok: true, run: sanitizeRunForDisplay(run), plan });
    }
    const itemMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/items\/([^/]+)$/);
    if (req.method === "PATCH" && itemMatch) {
      const run = findRun(itemMatch[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      const item = run.items.find((candidate) => candidate.id === itemMatch[2]);
      if (!item) return send(res, 404, { error: "item not found" });
      Object.assign(item, await readBody(req), { updatedAt: new Date().toISOString() });
      run.updatedAt = item.updatedAt;
      run.report = buildReport(run);
      saveRun(run);
      refreshCoordination(run);
      return send(res, 200, { ok: true, run: sanitizeRunForDisplay(run), item: sanitizeItemForDisplay(item) });
    }
    const registerItemMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/items\/register$/);
    if (req.method === "POST" && registerItemMatch) {
      const run = findRun(registerItemMatch[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      const item = registerFocusedItem(run, await readBody(req));
      return send(res, 200, { ok: true, run: sanitizeRunForDisplay(findRun(run.id) || run), item: sanitizeItemForDisplay(item) });
    }
    const wtMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/worktree$/);
    if (req.method === "POST" && wtMatch) {
      const run = findRun(wtMatch[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      const item = createWorktree(run, wtMatch[2]);
      return send(res, 200, { ok: true, run: sanitizeRunForDisplay(run), item: sanitizeItemForDisplay(item) });
    }
    const codexMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/codex-session$/);
    if (req.method === "POST" && codexMatch) {
      const run = findRun(codexMatch[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      const body = await readBody(req);
      const session = startCodexSession(run, codexMatch[2], body || {});
      const updated = findRun(run.id) || run;
      const item = updated.items.find((candidate) => candidate.id === codexMatch[2]);
      return send(res, 200, { ok: true, run: sanitizeRunForDisplay(updated), item: sanitizeItemForDisplay(item), session: sanitizeSessionForDisplay(session) });
    }
    const resultMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/handoff-result$/);
    if (req.method === "POST" && resultMatch) {
      const run = findRun(resultMatch[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      const body = await readBody(req);
      const item = recordHandoffResult(run, resultMatch[2], body || {});
      return send(res, 200, { ok: true, run: sanitizeRunForDisplay(findRun(run.id) || run), item: sanitizeItemForDisplay(item) });
    }
    const logMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/codex-sessions\/([^/]+)\/log$/);
    if (req.method === "GET" && logMatch) {
      const run = findRun(logMatch[1]);
      const item = run?.items.find((candidate) => candidate.id === logMatch[2]);
      const session = item?.codexSessions?.find((entry) => entry.id === logMatch[3]);
      if (!session) return send(res, 404, { error: "session not found" });
      const log = existsSync(session.logPath) ? readFileSync(session.logPath, "utf-8") : "";
      return send(res, 200, { session, log });
    }
    if (req.method === "GET" && url.pathname === "/api/codex/status") {
      return send(res, 200, codexExecutorStatus());
    }
    if (req.method === "GET" && url.pathname === "/api/codex/watchdog") {
      const targetId = url.searchParams.get("targetId") || "codenext";
      const idleMs = Number(url.searchParams.get("idleMs") || 10 * 60_000);
      return send(res, 200, await monitorCurrentCodex({ targetId, idleMs }));
    }
    if (req.method === "POST" && url.pathname === "/api/codex/watchdog") {
      const body = await readBody(req);
      return send(res, 200, await monitorCurrentCodex(body || {}));
    }
    const planMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/merge-plan$/);
    if (req.method === "GET" && planMatch) {
      const run = findRun(planMatch[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      return send(res, 200, mergePlan(run));
    }
    if (req.method === "GET" && staticFile(url.pathname, res)) return;
    send(res, 404, { error: "not found", path: url.pathname, file: basename(url.pathname) });
  } catch (err) {
    send(res, 500, { error: err.message || "Steve failed" });
  }
}

export {
  autoRunTarget,
  createRunWithHealth,
  findRun,
  ingestResultFiles,
  mergePlan,
  monitorCurrentCodex,
  notifyCurrentCodex,
  registerFocusedItem,
  refreshCoordination,
  runVisualScore,
  runs,
  targetSummaries,
  targets,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = http.createServer(route);
  server.on("error", (err) => {
    console.error(`Steve server failed to start: ${err.message}`);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
    console.log(`Steve running at http://${HOST}:${PORT}`);
    console.log(`Targets: ${targets().map((target) => target.name).join(", ") || "none"}`);
  });
}
