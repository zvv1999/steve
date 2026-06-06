import http from "node:http";
import https from "node:https";
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
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

async function targetSummaries() {
  return Promise.all(targets().map(async (target) => ({
    ...target,
    health: await targetHealth(target),
  })));
}

function runs() {
  return readJson(RUNS_FILE, { runs: [] }).runs || [];
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

function writeRunContext(run) {
  const dir = runStateDir(run.id);
  mkdirSync(dir, { recursive: true });
  const contextPath = join(dir, "run-context.md");
  const handoffItems = (run.items || []).filter((item) => item.codexSessions?.some((session) => session.mode === "app-handoff"));
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
    "",
    "## Coordination",
    "",
    "- Steve 是 coordinator：负责拆任务、生成上下文、登记 handoff、回收报告、决定下一轮。",
    "- Codex App worker 是并行执行单元：每个 worker 只处理一个候选点，避免互相覆盖。",
    "- 所有 worker 产物必须回到 Steve artifacts 或对应 worktree，并在 Steve item 状态里登记。",
    "- 如果发现依赖另一个 worker 的结论，先在报告里声明依赖，不要猜测对方结果。",
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
      "",
    ].join("\n")),
    "## Return Contract",
    "",
    "Worker 完成后必须返回中文报告，并至少包含：",
    "- 结论：建议合并 / 暂不合并 / 需要人工确认",
    "- 改动摘要或体验发现",
    "- 证据路径",
    "- 验证结果",
    "- 剩余风险",
    "- 建议 Steve 下一步派生的 worker",
  ];
  writeFileSync(contextPath, lines.join("\n"), "utf-8");
  run.runContextPath = contextPath;
  return contextPath;
}

function writeCoordinationPlan(run) {
  const dir = runStateDir(run.id);
  mkdirSync(dir, { recursive: true });
  const coordinationPath = join(dir, "coordination.json");
  const workers = (run.items || [])
    .filter((item) => item.codexSessions?.some((session) => session.mode === "app-handoff"))
    .map((item) => {
      const session = item.codexSessions.findLast?.((entry) => entry.mode === "app-handoff")
        || [...(item.codexSessions || [])].reverse().find((entry) => entry.mode === "app-handoff");
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
        dependsOn: item.id === "visual-quality-score" ? [] : ["visual-quality-score"],
      };
    });
  const plan = {
    runId: run.id,
    targetId: run.targetId,
    targetName: run.targetName,
    productMode: run.productMode || "general",
    strategy: "coordinator-plus-parallel-codex-app-workers",
    coordinator: {
      name: "Steve",
      responsibilities: [
        "generate shared context",
        "spawn or register multiple Codex App handoffs",
        "collect reports",
        "update run state",
        "decide next iteration",
      ],
    },
    maxParallelCodex: 4,
    sharedContextPath: run.runContextPath || null,
    visualBaseline: run.items?.find((item) => item.id === "visual-quality-score")?.visualScore || null,
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
  const prefix = `steve/${target.id}/${id.replace(/^steve-/, "").replace(/z$/, "")}`;
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
    branch: `${prefix}/${item.id}`,
    worktreePath: join(basePath, item.id),
    updatedAt: null,
  }));
}

function buildReport(run) {
  const slots = run.nightWindow?.slots?.join(" / ") || "未配置";
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
    "",
    "## 候选点",
    "",
  ];
  for (const item of run.items) {
    lines.push(`### ${item.title}`);
    lines.push(`- 类型：${item.type === "feature" ? "新功能" : "体验优化"}`);
    lines.push(`- 价值评分：${item.valueScore}`);
    lines.push(`- 风险：${item.risk}`);
    lines.push(`- 状态：${item.status}`);
    lines.push(`- Agent：${item.agent}`);
    lines.push(`- Skill：${item.skill}`);
    lines.push(`- 观察：${item.finding}`);
    lines.push(`- 建议：${item.proposal}`);
    lines.push(`- Worktree：${item.worktreePath}`);
    lines.push(`- 分支：${item.branch}`);
    if (item.visualScore) {
      lines.push(`- 视觉评分：${item.visualScore.score}/${item.visualScore.maxScore || 100}（阈值 ${item.visualScore.minScore}，${item.visualScore.passed ? "通过" : "未通过"}）`);
      lines.push(`- 视觉报告：${item.visualScore.reportPath}`);
    }
    if (item.codexSessions?.length) {
      const latest = item.codexSessions[item.codexSessions.length - 1];
      lines.push(`- Codex 会话：${latest.status}，${latest.startedAt || ""}`);
      lines.push(`- 结果文件：${latest.resultPath || "未产出"}`);
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

function mergePlan(run) {
  const selected = run.items.filter((item) => item.selected);
  return {
    runId: run.id,
    targetRoot: run.targetRoot,
    baseBranch: run.baseBranch,
    selected: selected.map((item) => ({
      id: item.id,
      title: item.title,
      branch: item.branch,
      path: item.worktreePath,
      command: `git merge --no-ff ${item.branch}`,
    })),
    commands: [
      `cd ${run.targetRoot}`,
      `git checkout ${run.baseBranch}`,
      ...selected.map((item) => `git merge --no-ff ${item.branch}`),
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
    let result = spawnSync("git", ["worktree", "add", "-b", item.branch, item.worktreePath, run.baseBranch], {
      cwd: run.targetRoot,
      encoding: "utf-8",
    });
    if (result.status !== 0 && /already exists/i.test(`${result.stderr}\n${result.stdout}`)) {
      result = spawnSync("git", ["worktree", "add", item.worktreePath, item.branch], {
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
    `- Branch: ${item.branch}`,
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
    "## 验证清单",
    "",
    ...(item.checklist || []).map((line) => `- ${line}`),
    "",
    "## 工作规则",
    "",
    "- 你不是孤立工作：不要改动 Steve 项目自身，除非任务明确要求。",
    "- 你属于一个多 Codex App worker 团队；先阅读 Shared run context，理解其他 worker 的职责。",
    "- 只在当前 worktree 中完成这个候选点，避免影响其他 worker。",
    "- 不要泄露密钥、cookie、token 或线上私有配置。",
    "- 如果 target 是 enterprise，不要因为出现企业集成能力就直接删除；优先检查默认文案、边界说明和降级体验。",
    "- 如果发现这个候选点不值得做，说明原因并停止，不要硬改。",
    "- 完成后必须用中文总结：做了什么、验证了什么、风险是什么、是否建议合并。",
    "",
    "## 期望输出",
    "",
    "请最终输出一个中文报告，包含：",
    "- 结论：建议合并 / 暂不合并 / 需要人工确认",
    "- 改动摘要",
    "- 验证结果",
    "- 剩余风险",
    "- 后续建议",
    "- 上下文回收：报告路径、是否依赖其他 worker、建议 Steve 下一轮派生任务",
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
  const latestSession = item.codexSessions?.findLast?.((session) => session.mode === "app-handoff")
    || [...(item.codexSessions || [])].reverse().find((session) => session.mode === "app-handoff");
  const finishedAt = new Date().toISOString();
  const resultText = String(result.report || result.summary || "").trim();
  const resultPath = result.resultPath || latestSession?.resultPath || join(itemStateDir(run.id, item.id), "result.md");

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
    latestSession.recommendation = result.recommendation || null;
    latestSession.dependsOn = result.dependsOn || [];
    latestSession.nextWorkers = result.nextWorkers || [];
  }

  item.status = result.itemStatus || (result.recommendation === "needs-polish" ? "needs-polish" : "codex-completed");
  item.validationNotes = result.summary || result.validationNotes || item.validationNotes || "";
  item.resultPath = resultPath;
  item.dependsOn = result.dependsOn || item.dependsOn || [];
  item.nextWorkers = result.nextWorkers || [];
  item.updatedAt = finishedAt;
  run.updatedAt = finishedAt;
  refreshCoordination(run);
  return item;
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

async function autoRunTarget(targetId) {
  const run = await createRunWithHealth(targetId);
  for (const item of run.items) {
    if (item.id === "visual-quality-score") continue;
    if (item.selected || item.required) {
      startCodexSession(run, item.id, { executor: "app-handoff" });
    }
  }
  runVisualScore(findRun(run.id) || run);
  const latest = findRun(run.id) || run;
  latest.status = "running";
  latest.updatedAt = new Date().toISOString();
  latest.report = buildReport(latest);
  saveRun(latest);
  refreshCoordination(latest);
  return latest;
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
    if (req.method === "GET" && url.pathname === "/api/runs") return send(res, 200, { runs: runs() });
    if (req.method === "POST" && url.pathname === "/api/runs") {
      const body = await readBody(req);
      return send(res, 200, { ok: true, run: await createRunWithHealth(body.targetId || "codenext") });
    }
    if (req.method === "POST" && url.pathname === "/api/auto-run") {
      const body = await readBody(req);
      const run = await autoRunTarget(body.targetId || "codenext");
      return send(res, 200, { ok: true, run, mergePlan: mergePlan(run) });
    }
    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      const run = findRun(runMatch[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      return send(res, 200, { run, mergePlan: mergePlan(run) });
    }
    const coordinationMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/coordination$/);
    if (req.method === "GET" && coordinationMatch) {
      const run = findRun(coordinationMatch[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      const plan = refreshCoordination(run);
      return send(res, 200, { ok: true, run, plan });
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
      return send(res, 200, { ok: true, run, item });
    }
    const wtMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/worktree$/);
    if (req.method === "POST" && wtMatch) {
      const run = findRun(wtMatch[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      return send(res, 200, { ok: true, run, item: createWorktree(run, wtMatch[2]) });
    }
    const codexMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/codex-session$/);
    if (req.method === "POST" && codexMatch) {
      const run = findRun(codexMatch[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      const body = await readBody(req);
      const session = startCodexSession(run, codexMatch[2], body || {});
      const updated = findRun(run.id) || run;
      const item = updated.items.find((candidate) => candidate.id === codexMatch[2]);
      return send(res, 200, { ok: true, run: updated, item, session });
    }
    const resultMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/items\/([^/]+)\/handoff-result$/);
    if (req.method === "POST" && resultMatch) {
      const run = findRun(resultMatch[1]);
      if (!run) return send(res, 404, { error: "run not found" });
      const body = await readBody(req);
      const item = recordHandoffResult(run, resultMatch[2], body || {});
      return send(res, 200, { ok: true, run: findRun(run.id) || run, item });
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

http.createServer(route).listen(PORT, HOST, () => {
  console.log(`Steve running at http://${HOST}:${PORT}`);
  console.log(`Targets: ${targets().map((target) => target.name).join(", ") || "none"}`);
});
