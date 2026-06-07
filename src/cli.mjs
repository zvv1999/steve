#!/usr/bin/env node
import { chromium } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  const args = { command: argv[2] || "audit" };
  for (let i = 3; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf-8"));
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/\bark-[A-Za-z0-9_-]+\b/g, "ark-***")
    .replace(/\b(sk|ak|pk)-[A-Za-z0-9_-]{16,}\b/g, "$1-***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, "Bearer ***");
}

function short(text, max = 260) {
  return redactSecrets(text).replace(/\s+/g, " ").trim().slice(0, max);
}

function safeFileName(text) {
  return String(text || "journey").replace(/[^\w\u4e00-\u9fa5-]+/g, "-");
}

function parseCookieJar(text) {
  const cookies = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("#") && !line.startsWith("#HttpOnly_")) continue;
    const parts = line.split(/\t/);
    if (parts.length < 7) continue;
    const [domain, , path, secure, expires, name, value] = parts;
    if (!name || !value) continue;
    cookies.push({
      name,
      value,
      domain: domain.replace(/^#HttpOnly_/, "").replace(/^\./, "") || "127.0.0.1",
      path: path || "/",
      expires: Number(expires) > 0 ? Number(expires) : undefined,
      httpOnly: false,
      secure: String(secure).toUpperCase() === "TRUE",
      sameSite: "Lax",
    });
  }
  return cookies;
}

async function loadCookieJar(path, host) {
  if (!path) return [];
  const text = await readFile(path, "utf-8").catch(() => "");
  if (!text) return [];
  return parseCookieJar(text).map((cookie) => ({
    ...cookie,
    domain: host || cookie.domain,
  }));
}

function addFinding(findings, item) {
  findings.push({
    id: `ux-${String(findings.length + 1).padStart(3, "0")}`,
    autoFixable: false,
    ...item,
  });
}

async function visibleText(page) {
  return page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
}

async function countActions(page) {
  const [buttons, links, inputs] = await Promise.all([
    page.getByRole("button").count().catch(() => 0),
    page.getByRole("link").count().catch(() => 0),
    page.locator("input, textarea, select").count().catch(() => 0),
  ]);
  return { buttons, links, inputs, total: buttons + links + inputs };
}

async function findLayoutIssues(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const redact = (text) => String(text || "")
      .replace(/\bark-[A-Za-z0-9_-]+\b/g, "ark-***")
      .replace(/\b(sk|ak|pk)-[A-Za-z0-9_-]{16,}\b/g, "$1-***")
      .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, "Bearer ***")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const items = [];
    for (const el of document.querySelectorAll("button, a, input, textarea, select, [role='button'], [role='link'], .card, .modal, .panel, .sidebar, .toolbar")) {
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      if (["input", "textarea", "select"].includes(tag)) continue;
      const overX = el.scrollWidth - el.clientWidth;
      const overY = el.scrollHeight - el.clientHeight;
      if (overX <= 2 && overY <= 2) continue;
      const rect = el.getBoundingClientRect();
      items.push({
        tag,
        role: el.getAttribute("role") || "",
        className: String(el.className || "").slice(0, 120),
        text: redact(el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || ""),
        overflow: { x: Math.round(overX), y: Math.round(overY) },
        box: { width: Math.round(rect.width), height: Math.round(rect.height) },
      });
      if (items.length >= 8) break;
    }
    return items;
  }).catch(() => []);
}

function evaluateHeuristics({ journey, text, actions, heuristics, findings }) {
  for (const rule of heuristics.textRules || []) {
    const pattern = new RegExp(rule.pattern, rule.flags || "");
    if (!pattern.test(text)) continue;
    addFinding(findings, {
      priority: rule.priority,
      area: journey.name,
      issue: rule.issue,
      evidence: `${journey.path} matched heuristic: ${rule.name}`,
      suggestion: rule.suggestion,
      autoFixable: Boolean(rule.autoFixable),
      heuristic: rule.name,
    });
  }

  if (actions.total === 0 && journey.allowNoActions !== true) {
    addFinding(findings, {
      priority: "P2",
      area: journey.name,
      issue: "Page has no obvious action",
      evidence: `${journey.path} has no button, link, input, textarea, or select.`,
      suggestion: "Add an obvious next step, such as returning home, creating something, configuring the product, or opening docs.",
      autoFixable: true,
      heuristic: "dead-end",
    });
  }
}

async function login(page, { baseUrl, username, password, findings, transcript }) {
  const loginUrl = new URL("/login.html", baseUrl).toString();
  transcript.push(`# Login\n\nURL: ${loginUrl}\n`);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

  const usernameByLabel = page.getByLabel("用户名");
  if (await usernameByLabel.count().catch(() => 0)) {
    await usernameByLabel.fill(username);
  } else if (await page.locator("#username").count().catch(() => 0)) {
    addFinding(findings, {
      priority: "P2",
      area: "Login",
      issue: "Username field lacks a common accessible label",
      evidence: "The audit had to fall back to #username.",
      suggestion: "Add aria-label or a label with the expected accessible name.",
      autoFixable: true,
      heuristic: "accessibility",
    });
    await page.locator("#username").fill(username);
  }

  const passwordByLabel = page.getByLabel("密码");
  if (await passwordByLabel.count().catch(() => 0)) {
    await passwordByLabel.fill(password);
  } else if (await page.locator("#password").count().catch(() => 0)) {
    await page.locator("#password").fill(password);
  }

  const loginButton = page.getByRole("button", { name: "登录" });
  if (await loginButton.count().catch(() => 0)) {
    await loginButton.click();
  }
  await page.waitForURL((url) => !url.pathname.endsWith("/login.html"), { timeout: 5000 }).catch(() => {});

  const text = await visibleText(page);
  if (page.url().endsWith("/login.html") || /密码|错误|失败|invalid|error/i.test(text)) {
    addFinding(findings, {
      priority: "P0",
      area: "Login",
      issue: "Default login failed",
      evidence: short(text),
      suggestion: "Verify audit credentials and local user initialization.",
      autoFixable: false,
      heuristic: "auth",
    });
    return false;
  }
  transcript.push(`Login succeeded: ${page.url()}\n`);
  return true;
}

async function auditJourney(page, journey, context) {
  const { baseUrl, screenshotDir, heuristics, rows, findings, transcript, viewport } = context;
  const url = new URL(journey.path, baseUrl).toString();
  const screenshot = `${safeFileName(`${viewport.id}-${journey.name}`)}.png`;
  const row = {
    id: journey.id,
    name: journey.name,
    viewport: viewport.id,
    goal: journey.goal,
    url,
    ok: true,
    missing: [],
    screenshot: `screenshots/${screenshot}`,
    notes: [],
    actions: null,
  };

  transcript.push(`## ${journey.name}\n\nGoal: ${journey.goal || "Audit this route"}\nURL: ${url}\n`);
  const response = await page.goto(url, { waitUntil: "domcontentloaded" }).catch((error) => {
    row.ok = false;
    row.notes.push(`Navigation failed: ${error.message}`);
    return null;
  });

  if (response && response.status() >= 400) {
    row.ok = false;
    row.notes.push(`HTTP ${response.status()}`);
  }

  await page.waitForLoadState("networkidle", { timeout: journey.networkIdleTimeoutMs || 3500 }).catch(() => {
    row.notes.push("Page did not quickly reach networkidle.");
  });

  const text = await visibleText(page);
  for (const expected of journey.expect || []) {
    if (text.includes(expected)) continue;
    row.ok = false;
    row.missing.push(expected);
    addFinding(findings, {
      priority: "P1",
      area: journey.name,
      issue: "Expected product copy is missing",
      evidence: `${journey.path} did not show: ${expected}`,
      suggestion: "Check routing, build output, and visible copy.",
      autoFixable: false,
      heuristic: "expected-copy",
    });
  }

  const actions = await countActions(page);
  row.actions = actions;
  evaluateHeuristics({ journey, text, actions, heuristics, findings });

  if (journey.disallowOverflow !== false) {
    const layoutIssues = await findLayoutIssues(page);
    row.layoutIssues = layoutIssues;
    if (layoutIssues.length) {
      addFinding(findings, {
        priority: "P2",
        area: `${journey.name} (${viewport.id})`,
        issue: "Visible UI element has overflowing content",
        evidence: JSON.stringify(layoutIssues.slice(0, 3)),
        suggestion: "Tighten responsive sizing, wrapping, or overflow behavior so labels and controls do not clip.",
        autoFixable: false,
        heuristic: "layout-overflow",
      });
    }
  }

  await page.screenshot({ path: join(screenshotDir, screenshot), fullPage: true }).catch((error) => {
    row.notes.push(`Screenshot failed: ${error.message}`);
  });

  row.preview = short(text);
  transcript.push(`Visible text: ${row.preview}\nActions: ${JSON.stringify(actions)}\nScreenshot: ${row.screenshot}\n`);
  rows.push(row);
}

async function runHealthChecks(context, { baseUrl, journeySet, findings, transcript }) {
  const checks = [];
  for (const check of journeySet.healthChecks || []) {
    const url = new URL(check.path, baseUrl).toString();
    const method = String(check.method || "GET").toUpperCase();
    const response = await context.request.fetch(url, {
      method,
      data: check.body,
      timeout: check.timeoutMs || 8000,
    }).catch((error) => ({ error }));
    const item = {
      id: check.id,
      name: check.name || check.id,
      method,
      url,
      ok: false,
    };
    if (response.error) {
      item.error = response.error.message;
    } else {
      item.status = response.status();
      item.ok = item.status >= (check.minStatus || 200) && item.status <= (check.maxStatus || 299);
      if (check.expectJson) {
        const json = await response.json().catch(() => null);
        item.jsonPreview = json && typeof json === "object" ? Object.keys(json).slice(0, 12) : null;
        if (check.expectJsonKey && !(json && Object.prototype.hasOwnProperty.call(json, check.expectJsonKey))) {
          item.ok = false;
          item.error = `Missing JSON key: ${check.expectJsonKey}`;
        }
      }
    }
    if (!item.ok) {
      addFinding(findings, {
        priority: check.priority || "P1",
        area: "Health checks",
        issue: `Health check failed: ${item.name}`,
        evidence: item.error || `${method} ${check.path} returned HTTP ${item.status}`,
        suggestion: check.suggestion || "Make this endpoint return a stable success response during the personal-edition product flow.",
        autoFixable: false,
        heuristic: "health-check",
      });
    }
    checks.push(item);
  }
  if (checks.length) {
    transcript.push(`## Health checks\n\n${JSON.stringify(checks, null, 2)}\n`);
  }
  return checks;
}

async function requestJson(context, method, url, body) {
  const response = await context.request.fetch(url, {
    method,
    data: body,
    timeout: 15000,
  });
  const text = await response.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { response, status: response.status(), json, text };
}

function checkCoreStep({ results, findings, id, name, ok, evidence, suggestion, priority = "P1" }) {
  results.push({ id, name, ok, evidence });
  if (!ok) {
    addFinding(findings, {
      priority,
      area: "Core product workflow",
      issue: `Core step failed: ${name}`,
      evidence,
      suggestion,
      autoFixable: false,
      heuristic: "core-workflow",
    });
  }
}

async function runCoreWorkflows(context, { baseUrl, journeySet, findings, transcript }) {
  const results = [];
  for (const workflow of journeySet.coreWorkflows || []) {
    if (workflow.type !== "project-lifecycle") continue;
    const projectName = `${workflow.projectPrefix || "steve_core"}_${Date.now()}`;
    const createUrl = new URL("/api/projects", baseUrl).toString();
    let projectId = null;
    let projectPath = null;
    transcript.push(`## Core workflow: ${workflow.name || workflow.type}\n\n`);

    try {
      const created = await requestJson(context, "POST", createUrl, { name: projectName });
      projectId = created.json?.id;
      projectPath = created.json?.path;
      checkCoreStep({
        results,
        findings,
        id: "create-project",
        name: "Create a disposable project",
        ok: created.status === 200 && Boolean(projectId) && Boolean(projectPath),
        evidence: `HTTP ${created.status}; id=${projectId || "missing"}; path=${projectPath || "missing"}`,
        suggestion: "Project creation should return a stable project id and workspace path.",
      });
      if (!projectId || !projectPath) continue;

      await writeFile(join(projectPath, "README.md"), "# Steve core audit\n\nInitial content from product workflow.\n", "utf-8");
      const listUrl = new URL(`/api/projects/${encodeURIComponent(projectId)}/fs/list`, baseUrl).toString();
      const listed = await requestJson(context, "GET", listUrl);
      const hasReadme = Array.isArray(listed.json?.entries) && listed.json.entries.some((item) => item.name === "README.md");
      checkCoreStep({
        results,
        findings,
        id: "list-files",
        name: "List project files",
        ok: listed.status === 200 && hasReadme,
        evidence: `HTTP ${listed.status}; README visible=${hasReadme}`,
        suggestion: "The file browser should show files present in the project workspace.",
      });

      const readUrl = new URL(`/api/projects/${encodeURIComponent(projectId)}/fs/read?path=README.md`, baseUrl).toString();
      const read = await requestJson(context, "GET", readUrl);
      checkCoreStep({
        results,
        findings,
        id: "read-file",
        name: "Read a project file",
        ok: read.status === 200 && /Steve core audit/.test(read.json?.content || ""),
        evidence: `HTTP ${read.status}; size=${read.json?.size ?? "missing"}`,
        suggestion: "Opening a text file should return UTF-8 content and metadata.",
      });

      const writeUrl = new URL(`/api/projects/${encodeURIComponent(projectId)}/fs/write`, baseUrl).toString();
      const updatedContent = "# Steve core audit\n\nEdited through CodeNext file API.\n";
      const wrote = await requestJson(context, "POST", writeUrl, { path: "README.md", content: updatedContent });
      const reread = await requestJson(context, "GET", readUrl);
      checkCoreStep({
        results,
        findings,
        id: "write-file",
        name: "Edit and persist a file",
        ok: wrote.status === 200 && reread.json?.content === updatedContent,
        evidence: `write HTTP ${wrote.status}; reread matches=${reread.json?.content === updatedContent}`,
        suggestion: "The simple editor should persist changes and read them back without stale content.",
      });

      const gitUrl = new URL(`/api/projects/${encodeURIComponent(projectId)}/git-status`, baseUrl).toString();
      const git = await requestJson(context, "GET", gitUrl);
      const expectFreshProjectGitRepo = workflow.expectFreshProjectGitRepo === true;
      checkCoreStep({
        results,
        findings,
        id: "git-status",
        name: "Read Git status without inheriting the app repository",
        ok: git.status === 200 && git.json?.isGitRepo === expectFreshProjectGitRepo,
        evidence: `HTTP ${git.status}; isGitRepo=${git.json?.isGitRepo}`,
        suggestion: "Fresh projects should live outside the CodeNext app repository unless the user explicitly imports or initializes a Git repo.",
      });

      const sessionsUrl = new URL(`/api/projects/${encodeURIComponent(projectId)}/sessions`, baseUrl).toString();
      const sessions = await requestJson(context, "GET", sessionsUrl);
      checkCoreStep({
        results,
        findings,
        id: "sessions-list",
        name: "List project sessions",
        ok: sessions.status === 200 && Array.isArray(sessions.json?.sessions),
        evidence: `HTTP ${sessions.status}; sessions=${Array.isArray(sessions.json?.sessions) ? sessions.json.sessions.length : "missing"}`,
        suggestion: "A new project should expose an empty, well-formed session list.",
      });

      const modelsUrl = new URL("/api/gateway/models", baseUrl).toString();
      const models = await requestJson(context, "GET", modelsUrl);
      checkCoreStep({
        results,
        findings,
        id: "gateway-models-core",
        name: "Discover AI gateway models",
        ok: models.status === 200 && Array.isArray(models.json?.models) && models.json.models.length > 0,
        evidence: `HTTP ${models.status}; models=${Array.isArray(models.json?.models) ? models.json.models.length : "missing"}`,
        suggestion: "Model discovery should prove that the configured AI gateway is ready before the user starts coding.",
      });
    } finally {
      if (projectId) {
        const deleteUrl = new URL(`/api/projects/${encodeURIComponent(projectId)}`, baseUrl).toString();
        const deleted = await requestJson(context, "DELETE", deleteUrl).catch((error) => ({ status: 0, error }));
        results.push({
          id: "cleanup-project",
          name: "Cleanup disposable project record",
          ok: deleted.status >= 200 && deleted.status < 300,
          evidence: `HTTP ${deleted.status}`,
        });
      }
    }
  }
  if (results.length) transcript.push(`${JSON.stringify(results, null, 2)}\n`);
  return results;
}

function renderReport({ run, rows, findings, consoleEvents, networkEvents, healthChecks, coreWorkflows }) {
  const lines = [
    "# Product Experience Audit",
    "",
    `- Goal: ${run.goal}`,
    `- Target: ${run.target}`,
    `- Persona: ${run.persona.name} (${run.persona.id})`,
    `- Journey set: ${run.journeySet.name} (${run.journeySet.id})`,
    `- Time: ${run.startedAt}`,
    `- Journeys: ${run.summary.passed}/${run.summary.journeys} passed`,
    `- Findings: ${run.summary.findings} (${run.summary.blockingFindings} blocking)`,
    `- Console/Page errors: ${consoleEvents.length}`,
    `- Network 5xx errors: ${networkEvents.length}`,
    `- Health checks: ${healthChecks.filter((item) => item.ok).length}/${healthChecks.length} passed`,
    `- Core workflow steps: ${coreWorkflows.filter((item) => item.ok).length}/${coreWorkflows.length} passed`,
    "",
    "## Journey Results",
    "",
    "| Area | Status | Evidence | Screenshot |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => {
      const status = row.ok ? "PASS" : "FAIL";
      const evidence = row.missing.length ? `Missing: ${row.missing.join(", ")}` : row.notes.join("; ") || row.preview;
      return `| ${row.name} (${row.viewport}) | ${status} | ${evidence.replaceAll("|", "\\|")} | ${row.screenshot} |`;
    }),
    "",
    "## Findings",
    "",
  ];

  if (!findings.length) {
    lines.push("No blocking UX findings from the scripted pass.");
  } else {
    for (const item of findings) {
      lines.push(`### ${item.priority} · ${item.area}`);
      lines.push("");
      lines.push(`- Issue: ${item.issue}`);
      lines.push(`- Evidence: ${item.evidence}`);
      lines.push(`- Suggestion: ${item.suggestion}`);
      lines.push(`- Auto-fixable: ${item.autoFixable ? "yes" : "no"}`);
      lines.push("");
    }
  }

  if (consoleEvents.length) {
    lines.push("", "## Console/Page Errors", "");
    for (const event of consoleEvents.slice(0, 50)) {
      lines.push(`- [${event.type}] ${event.url || ""} ${event.text}`);
    }
  }

  if (networkEvents.length) {
    lines.push("", "## Network 5xx Errors", "");
    for (const event of networkEvents.slice(0, 50)) {
      lines.push(`- HTTP ${event.status}: ${event.url}`);
    }
  }

  if (healthChecks.length) {
    lines.push("", "## Health Checks", "");
    for (const check of healthChecks) {
      lines.push(`- ${check.ok ? "PASS" : "FAIL"} · ${check.name}: ${check.status || check.error}`);
    }
  }

  if (coreWorkflows.length) {
    lines.push("", "## Core Workflows", "");
    for (const step of coreWorkflows) {
      lines.push(`- ${step.ok ? "PASS" : "FAIL"} · ${step.name}: ${redactSecrets(step.evidence)}`);
    }
  }

  lines.push(
    "",
    "## Codex Control Loop",
    "",
    "1. Read findings and screenshots.",
    "2. Fix P0/P1 first, then P2 polish.",
    "3. Run unit verification.",
    "4. Run this audit again.",
    "5. Compare before/after reports and produce the final product-experience summary.",
  );

  return lines.join("\n");
}

async function screenshotObservation(page, screenshotDir, planId, stepId) {
  const file = `${safeFileName(`${planId}-${stepId}`)}.png`;
  await page.screenshot({ path: join(screenshotDir, file), fullPage: true }).catch(() => {});
  return `screenshots/${file}`;
}

async function recordObservation({ observations, page, screenshotDir, planId, step, observation, extra = {} }) {
  observations.push({
    planId,
    step,
    url: page.url(),
    preview: short(await visibleText(page), 500),
    screenshot: await screenshotObservation(page, screenshotDir, planId, step),
    observation,
    ...extra,
  });
}

function renderReviewReport({ startedAt, baseUrl, persona, plans, observations, findings, consoleEvents, networkEvents }) {
  const lines = [
    "# 产品体验评审报告",
    "",
    `- 目标地址: ${baseUrl}`,
    `- 用户画像: ${persona.name} (${persona.id})`,
    `- 时间: ${startedAt}`,
    `- 测试计划: ${plans.length}`,
    `- 上手观察: ${observations.length}`,
    `- 产品发现: ${findings.length}`,
    `- Console 警告/错误: ${consoleEvents.length}`,
    `- 网络 5xx: ${networkEvents.length}`,
    "",
    "## 产品测试计划",
    "",
  ];

  for (const plan of plans) {
    lines.push(`### ${plan.name}`, "");
    lines.push(`- 产品问题: ${plan.productQuestion}`);
    lines.push(`- 成功信号: ${(plan.successSignals || []).join(" / ")}`);
    lines.push(`- 体验范围: ${(plan.experienceScope || []).join(" / ")}`);
    lines.push("");
  }

  lines.push("## 实际上手观察", "");
  for (const item of observations) {
    lines.push(`- [${item.planId}] ${item.step}: ${item.observation || item.evidence || item.preview}${item.screenshot ? ` (${item.screenshot})` : ""}`);
  }

  lines.push("", "## 问题与演进方向", "");
  if (!findings.length) {
    lines.push("本轮产品体验未发现明确问题。");
  } else {
    for (const item of findings) {
      lines.push(`### ${item.priority} · ${item.issue}`, "");
      lines.push(`- 计划: ${item.planId}`);
      lines.push(`- 证据: ${item.evidence}`);
      lines.push(`- 演进方向: ${item.evolution}`);
      if (item.fixDirection) lines.push(`- 修复方向: ${item.fixDirection}`);
      lines.push("");
    }
  }

  if (consoleEvents.length) {
    lines.push("## Console 警告/错误", "");
    for (const event of consoleEvents.slice(0, 50)) {
      lines.push(`- [${event.type}] ${event.url || ""} ${event.text}`);
    }
    lines.push("");
  }

  if (networkEvents.length) {
    lines.push("## 网络 5xx", "");
    for (const event of networkEvents.slice(0, 50)) {
      lines.push(`- HTTP ${event.status}: ${event.url}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function runCodeNextProductReview({ page, context, baseUrl, screenshotDir, observations, findings, review }) {
  const plans = review.plans || [];
  const findPlan = (id) => plans.find((plan) => plan.id === id) || { id, name: id };
  let tempProjectId = null;
  const tempProjectName = `${review.tempProjectPrefix || "steve_px"}_${Date.now()}`;

  const addApiObservation = ({ planId, step, ok, evidence }) => {
    observations.push({ planId, step, ok, evidence: short(evidence, 500) });
  };

  try {
    await recordObservation({
      observations,
      page,
      screenshotDir,
      planId: "activation",
      step: "logged-in-home",
      observation: "登录后进入工作台，项目侧栏和底部工具入口都可见，但主画布仍需要用户自己推断第一步该做什么。",
    });

    await page.locator("#new-project-btn").click();
    await page.waitForSelector("#modal-backdrop:not([hidden])", { timeout: 4000 }).catch(() => {});
    await recordObservation({
      observations,
      page,
      screenshotDir,
      planId: "activation",
      step: "new-project-modal",
      observation: "新建项目弹窗提供空项目、Git 克隆、本地会话导入。能力很强，但对首次激活来说选择密度偏高。",
    });

    await page.locator("#new-project-name").fill(tempProjectName);
    await page.locator("#modal-create-btn").click();
    await page.waitForSelector("#modal-backdrop[hidden]", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await recordObservation({
      observations,
      page,
      screenshotDir,
      planId: "activation",
      step: "project-created-ui",
      observation: "创建项目后，项目出现在侧栏，但主画布仍在解释项目/会话关系，没有主动把用户推向下一步。",
    });

    const projects = await requestJson(context, "GET", new URL("/api/projects", baseUrl).toString());
    const temp = Array.isArray(projects.json) ? projects.json.find((item) => item.name === tempProjectName) : null;
    tempProjectId = temp?.id || null;
    addApiObservation({
      planId: "activation",
      step: "project-created-api",
      ok: Boolean(tempProjectId),
      evidence: `projects HTTP ${projects.status}; found=${Boolean(tempProjectId)}`,
    });

    if (tempProjectId) {
      await page.getByText(tempProjectName, { exact: false }).click().catch(() => {});
      await page.waitForTimeout(1000);
      await recordObservation({
        observations,
        page,
        screenshotDir,
        planId: "core-coding",
        step: "project-opened",
        observation: "打开项目后可以看到新建会话入口。产品已经具备工作条件，但仍让用户自己拼起项目、会话和 AI 任务这些概念。",
      });

      const sessions = await requestJson(context, "GET", new URL(`/api/projects/${encodeURIComponent(tempProjectId)}/sessions`, baseUrl).toString());
      const git = await requestJson(context, "GET", new URL(`/api/projects/${encodeURIComponent(tempProjectId)}/git-status`, baseUrl).toString());
      addApiObservation({
        planId: "core-coding",
        step: "sessions-api",
        ok: Array.isArray(sessions.json?.sessions),
        evidence: `HTTP ${sessions.status}; sessions=${sessions.json?.sessions?.length ?? "missing"}`,
      });
      addApiObservation({
        planId: "core-coding",
        step: "git-status-api",
        ok: git.status === 200 && git.json?.isGitRepo === false,
        evidence: `HTTP ${git.status}; isGitRepo=${git.json?.isGitRepo}`,
      });
    }

    await page.goto(new URL("/settings.html", baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    await recordObservation({
      observations,
      page,
      screenshotDir,
      planId: "ai-readiness",
      step: "settings",
      observation: "网关设置能力完整且透明，但页面优先呈现 env、spawn、proxy 等实现术语。",
    });
    const models = await requestJson(context, "GET", new URL("/api/gateway/models", baseUrl).toString());
    addApiObservation({
      planId: "ai-readiness",
      step: "models-api",
      ok: Array.isArray(models.json?.models) && models.json.models.length > 0,
      evidence: `HTTP ${models.status}; models=${models.json?.models?.length ?? "missing"}`,
    });

    await page.goto(new URL("/proxy-logs.html", baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    await recordObservation({
      observations,
      page,
      screenshotDir,
      planId: "ai-readiness",
      step: "gateway-logs-empty",
      observation: "网关日志空态稳定，但在没有任何请求时仍提示选择一条请求。",
    });

    await page.goto(new URL("/skillhub.html", baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await recordObservation({
      observations,
      page,
      screenshotDir,
      planId: "ecosystem",
      step: "skillhub",
      observation: "技能中心通过 Git 导入、公共市场、本地技能传达了扩展能力；下一步应从浏览列表演进到基于目标的推荐。",
    });

    await page.goto(new URL("/mcp.html", baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await recordObservation({
      observations,
      page,
      screenshotDir,
      planId: "ecosystem",
      step: "mcp",
      observation: "MCP 扩展具体且容易理解，安装状态和使用场景都可见。",
    });

    await page.goto(new URL("/docs/", baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await recordObservation({
      observations,
      page,
      screenshotDir,
      planId: "opensource",
      step: "docs-overview",
      observation: "文档能较清楚地向外部读者解释云端 AI 编程平台定位。",
    });

    await page.goto(new URL("/docs/quickstart/", baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await recordObservation({
      observations,
      page,
      screenshotDir,
      planId: "opensource",
      step: "docs-quickstart",
      observation: "快速开始给出了路径，但仍带有云端容器假设；个人开源版需要更短、更本地优先的路径。",
    });

    await page.goto(new URL("/import.html", baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await recordObservation({
      observations,
      page,
      screenshotDir,
      planId: "opensource",
      step: "import-direct",
      observation: "导入直达页已经能优雅恢复，并引导用户回到主界面。",
    });
  } finally {
    if (tempProjectId) {
      await requestJson(context, "DELETE", new URL(`/api/projects/${encodeURIComponent(tempProjectId)}`, baseUrl).toString()).catch(() => {});
    }
  }

  for (const item of review.findings || []) {
    findings.push({
      priority: item.priority || "P2",
      planId: findPlan(item.planId).id,
      issue: item.issue,
      evidence: item.evidence,
      evolution: item.evolution,
      fixDirection: item.fixDirection,
    });
  }
}

async function runReview(args) {
  const configDir = resolve(args.config || "examples/codenext");
  const outDir = resolve(args.out || "artifacts/product-experience-review");
  const screenshotDir = join(outDir, "screenshots");
  const baseUrl = args.url || "http://127.0.0.1:3599";
  const username = args.user || process.env.CODEX_UX_USER || "admin";
  const password = args.pass || process.env.CODEX_UX_PASS;
  const startedAt = new Date().toISOString();
  const [persona, review] = await Promise.all([
    readJson(join(configDir, "personas", `${args.persona || "default"}.json`)),
    readJson(join(configDir, "reviews", `${args.review || "product"}.json`)),
  ]);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(screenshotDir, { recursive: true });

  const observations = [];
  const findings = [];
  const consoleEvents = [];
  const networkEvents = [];

  const browser = await chromium.launch({ headless: args.headed !== true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      consoleEvents.push({ type: message.type(), text: short(message.text(), 500), url: page.url() });
    }
  });
  page.on("pageerror", (error) => {
    consoleEvents.push({ type: "pageerror", text: short(error.message, 500), url: page.url() });
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      networkEvents.push({ status: response.status(), url: response.url() });
    }
  });

  try {
    if (review.login !== false) {
      if (!password) throw new Error("Review password was not provided. Pass --pass or set CODEX_UX_PASS.");
      const ok = await login(page, { baseUrl, username, password, findings, transcript: [] });
      if (!ok) throw new Error("Login failed.");
    }
    if (review.workflow !== "codenext-product") {
      throw new Error(`Unknown review workflow: ${review.workflow}`);
    }
    await runCodeNextProductReview({ page, context, baseUrl, screenshotDir, observations, findings, review });
  } finally {
    await browser.close();
  }

  await Promise.all([
    writeFile(join(outDir, "plans.json"), JSON.stringify(review.plans || [], null, 2)),
    writeFile(join(outDir, "observations.json"), JSON.stringify(observations, null, 2)),
    writeFile(join(outDir, "findings.json"), JSON.stringify(findings, null, 2)),
    writeFile(join(outDir, "console.json"), JSON.stringify(consoleEvents, null, 2)),
    writeFile(join(outDir, "network.json"), JSON.stringify(networkEvents, null, 2)),
    writeFile(join(outDir, "report.md"), renderReviewReport({
      startedAt,
      baseUrl,
      persona,
      plans: review.plans || [],
      observations,
      findings,
      consoleEvents,
      networkEvents,
    })),
  ]);

  console.log(`产品体验报告已写入 ${join(outDir, "report.md")}`);
  console.log(`产品发现已写入 ${join(outDir, "findings.json")}`);
}

async function runVisualStep(page, step) {
  if (step.type === "fill") {
    await page.locator(step.selector).fill(step.value || "");
    return;
  }
  if (step.type === "clickText") {
    const locator = page.locator(step.selector).filter({ hasText: step.text }).first();
    await locator.click();
    return;
  }
  if (step.type === "click") {
    await page.locator(step.selector).click();
    return;
  }
  if (step.type === "wait") {
    await page.waitForTimeout(Number(step.ms) || 100);
    return;
  }
  throw new Error(`Unknown visual step type: ${step.type}`);
}

async function inspectVisualState(page, viewport, visual) {
  return page.evaluate(({ viewport, selectors }) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const text = (selector) => Array.from(document.querySelectorAll(selector || ""))
      .filter(visible)
      .map((el) => el.textContent.trim())
      .filter(Boolean);
    const count = (selector) => Array.from(document.querySelectorAll(selector || "")).filter(visible).length;
    const overflowElements = Array.from(document.querySelectorAll(selectors.overflowTargets || "button, a, input"))
      .filter(visible)
      .filter((el) => el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)
      .slice(0, 12)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        className: String(el.className || "").slice(0, 120),
        text: el.textContent.trim().replace(/\s+/g, " ").slice(0, 80),
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      }));
    const smallTargets = Array.from(document.querySelectorAll("button, input, a, textarea, select"))
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          text: el.textContent.trim() || el.getAttribute("placeholder") || el.getAttribute("aria-label") || el.tagName,
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      })
      .filter((r) => r.width < 32 || r.height < 32)
      .slice(0, 12);
    return {
      viewport,
      title: document.title,
      url: location.href,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      hasHorizontalOverflow: document.body.scrollWidth > window.innerWidth + 2,
      cardCount: count(selectors.cards),
      marketCardCount: count(selectors.marketCards),
      curatedCardCount: count(selectors.curatedCards),
      scenarioButtons: text(selectors.scenarioButtons),
      filters: text(selectors.filters),
      groupTitles: text(selectors.groupTitles),
      matchReasons: text(selectors.matchReasons),
      stats: document.querySelector(selectors.stats || "")?.textContent.trim() || "",
      notice: document.querySelector(selectors.notice || "")?.textContent.trim() || "",
      emptyText: document.querySelector(".sk-empty")?.textContent.trim() || "",
      overflowElements,
      smallTargets,
    };
  }, { viewport, selectors: visual.selectors || {} });
}

function pushVisualIssue(issues, points, title, detail) {
  issues.push({ points, title, detail: redactSecrets(detail || "") });
}

function scoreVisual(results, visual) {
  const issues = [];
  const requirements = visual.requirements || {};
  for (const result of results) {
    if (result.consoleErrors.length) {
      pushVisualIssue(issues, 8, `${result.viewport} 有控制台错误`, result.consoleErrors.slice(0, 5).join("\n"));
    }
    if (result.failedRequests.length) {
      pushVisualIssue(issues, 5, `${result.viewport} 有失败请求`, result.failedRequests.slice(0, 5).join("\n"));
    }
    for (const state of result.states) {
      if (state.hasHorizontalOverflow) {
        pushVisualIssue(issues, 10, `${state.viewport} 出现横向溢出`, `body ${state.bodyWidth}px > viewport ${state.viewportWidth}px`);
      }
      if (state.overflowElements.length) {
        pushVisualIssue(issues, 6, `${state.viewport} 有元素内容溢出`, JSON.stringify(state.overflowElements.slice(0, 4), null, 2));
      }
      if (state.smallTargets.length > (requirements.maxSmallTargets ?? 3)) {
        pushVisualIssue(issues, 4, `${state.viewport} 有过小点击目标`, JSON.stringify(state.smallTargets.slice(0, 4), null, 2));
      }
      for (const text of requirements.statsIncludes || []) {
        if (!state.stats.includes(text)) {
          pushVisualIssue(issues, 5, `${state.viewport} 来源统计不清晰`, state.stats || "无统计文本");
        }
      }
      if (state.scenarioButtons.length < (requirements.minScenarioButtons || 0)) {
        pushVisualIssue(issues, 8, `${state.viewport} 场景入口不足`, state.scenarioButtons.join(" / "));
      }
      if (requirements.desktopRequiresGroups && state.viewport.includes("desktop") && !state.groupTitles.length) {
        pushVisualIssue(issues, 6, `${state.viewport} 官方能力没有分组展示`, "缺少分组标题");
      }
    }
    for (const interaction of visual.interactions || []) {
      const state = result.states.find((item) => item.id === interaction.id);
      if (!state) continue;
      if (interaction.expectMatchReasons && !state.matchReasons.length) {
        pushVisualIssue(issues, 7, `${result.viewport} 搜索结果缺少命中解释`, `${interaction.name} 未出现匹配原因`);
      }
      if (interaction.expectGroupTitle && !state.groupTitles.includes(interaction.expectGroupTitle)) {
        pushVisualIssue(issues, 6, `${result.viewport} 场景筛选未命中 ${interaction.expectGroupTitle}`, state.groupTitles.join(" / "));
      }
    }
  }
  const score = Math.max(0, 100 - issues.reduce((sum, item) => sum + item.points, 0));
  return { score, issues };
}

function renderVisualReport({ visual, baseUrl, results, score }) {
  const lines = [
    "# Steve 视觉体验评分报告",
    "",
    `- 对象: ${visual.name || visual.id}`,
    `- 页面: ${new URL(visual.path || "/", baseUrl).toString()}`,
    `- 评分: ${score.score}/100`,
    `- 阈值: ${visual.minScore || 92}`,
    `- 结论: ${score.score >= (visual.minScore || 92) ? "通过" : "未通过"}`,
    "",
    "## 截图",
  ];
  for (const result of results) {
    for (const state of result.states) {
      lines.push(`- ${state.viewport}: ${state.screenshot}`);
    }
  }
  lines.push("", "## 页面状态");
  for (const result of results) {
    const initial = result.states[0];
    lines.push(`- ${result.viewport}: 场景入口 ${initial.scenarioButtons.length} 个，官方分组 ${initial.groupTitles.length} 个，卡片 ${initial.cardCount} 个`);
  }
  lines.push("", "## 问题清单");
  if (!score.issues.length) {
    lines.push("- 未发现阻断性体验问题。");
  } else {
    for (const item of score.issues) {
      lines.push(`- 扣 ${item.points} 分: ${item.title}`);
      if (item.detail) lines.push(`  ${item.detail.replace(/\n/g, "\n  ")}`);
    }
  }
  if (visual.advice?.length) {
    lines.push("", "## Steve 建议");
    for (const item of visual.advice) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

async function runVisual(args) {
  const configDir = resolve(args.config || "examples/codenext");
  const visual = await readJson(join(configDir, "visual", `${args.visual || "skillhub"}.json`));
  const outDir = resolve(args.out || "artifacts/visual-score");
  const screenshotDir = join(outDir, "screenshots");
  const baseUrl = args.url || "http://127.0.0.1:3599";
  const base = new URL(baseUrl);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(screenshotDir, { recursive: true });

  const browser = await chromium.launch({ headless: args.headed !== true });
  const results = [];
  try {
    for (const viewport of visual.viewports || [{ id: "desktop", width: 1440, height: 1000 }]) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor || 1,
      });
      const cookies = await loadCookieJar(args["cookie-jar"] || process.env.STEVE_COOKIE_JAR, base.hostname);
      if (cookies.length) await context.addCookies(cookies);
      const page = await context.newPage();
      const consoleErrors = [];
      const failedRequests = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(short(message.text(), 500));
      });
      page.on("pageerror", (error) => {
        consoleErrors.push(short(error.message, 500));
      });
      page.on("requestfailed", (request) => {
        failedRequests.push(`${request.method()} ${request.url()}`);
      });

      const states = [];
      await page.goto(new URL(visual.path || "/", baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 20000 });
      if (visual.selectors?.ready) await page.waitForSelector(visual.selectors.ready, { timeout: 12000 });
      if (visual.selectors?.cards) await page.waitForSelector(visual.selectors.cards, { timeout: 12000 });
      await page.waitForTimeout(300);
      const initialShot = `screenshots/${safeFileName(`${viewport.id}-initial`)}.png`;
      await page.screenshot({ path: join(outDir, initialShot), fullPage: true });
      states.push({
        id: "initial",
        screenshot: initialShot,
        ...(await inspectVisualState(page, viewport.id, visual)),
      });

      for (const interaction of visual.interactions || []) {
        for (const step of interaction.steps || []) await runVisualStep(page, step);
        const shot = `screenshots/${safeFileName(`${viewport.id}-${interaction.id}`)}.png`;
        await page.screenshot({ path: join(outDir, shot), fullPage: true });
        states.push({
          id: interaction.id,
          screenshot: shot,
          ...(await inspectVisualState(page, `${viewport.id}-${interaction.id}`, visual)),
        });
      }
      results.push({ viewport: viewport.id, states, consoleErrors, failedRequests });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const score = scoreVisual(results, visual);
  await Promise.all([
    writeFile(join(outDir, "report.json"), JSON.stringify({ visual, results, score }, null, 2)),
    writeFile(join(outDir, "report.md"), renderVisualReport({ visual, baseUrl, results, score })),
  ]);
  console.log(`视觉评分报告已写入 ${join(outDir, "report.md")}`);
  console.log(`视觉评分: ${score.score}/100`);
  if (score.score < (visual.minScore || 92)) process.exitCode = 1;
}

async function runAudit(args) {
  const configDir = resolve(args.config || "examples/codenext");
  const outDir = resolve(args.out || "artifacts/ux-audit");
  const screenshotDir = join(outDir, "screenshots");
  const baseUrl = args.url || "http://127.0.0.1:3599";
  const username = args.user || process.env.CODEX_UX_USER || "admin";
  const password = args.pass || process.env.CODEX_UX_PASS;
  const startedAt = new Date().toISOString();
  const goal =
    args.goal ||
    "Open-source this website. Experience the product and decide whether it feels as smooth as an Apple product. If not, identify what to improve.";

  const [persona, journeySet, heuristics] = await Promise.all([
    readJson(join(configDir, "personas", `${args.persona || "default"}.json`)),
    readJson(join(configDir, "journeys", `${args.journeys || "default"}.json`)),
    readJson(join(configDir, "heuristics", `${args.heuristics || "default"}.json`)),
  ]);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(screenshotDir, { recursive: true });

  const findings = [];
  const rows = [];
  const consoleEvents = [];
  const networkEvents = [];
  let healthChecks = [];
  let coreWorkflows = [];
  const transcript = [];

  const browser = await chromium.launch({ headless: args.headed !== true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      consoleEvents.push({ type: message.type(), text: short(message.text(), 500), url: page.url() });
    }
  });
  page.on("pageerror", (error) => {
    consoleEvents.push({ type: "pageerror", text: short(error.message, 500), url: page.url() });
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      networkEvents.push({ status: response.status(), url: response.url() });
    }
  });

  try {
    if (journeySet.login !== false) {
      if (!password) {
        addFinding(findings, {
          priority: "P0",
          area: "Login",
          issue: "Audit password was not provided",
          evidence: "Pass --pass or set CODEX_UX_PASS before running an authenticated journey.",
          suggestion: "Provide explicit audit credentials for local test targets.",
          autoFixable: false,
          heuristic: "auth",
        });
        process.exitCode = 1;
        return;
      }
      const ok = await login(page, {
        baseUrl,
        username,
        password,
        findings,
        transcript,
      });
      if (!ok) process.exitCode = 1;
    }

    const viewports = journeySet.viewports?.length
      ? journeySet.viewports
      : [{ id: "desktop", width: 1440, height: 1000 }];
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      transcript.push(`# Viewport: ${viewport.id} (${viewport.width}x${viewport.height})\n`);
      for (const journey of journeySet.journeys) {
        await auditJourney(page, {
          ...journey,
        }, {
          baseUrl,
          screenshotDir,
          heuristics,
          rows,
          findings,
          transcript,
          viewport,
        });
      }
    }

    healthChecks = await runHealthChecks(context, { baseUrl, journeySet, findings, transcript });
    coreWorkflows = await runCoreWorkflows(context, { baseUrl, journeySet, findings, transcript });
  } finally {
    await browser.close();
  }

  if (networkEvents.length) {
    addFinding(findings, {
      priority: "P1",
      area: "Network",
      issue: "One or more server errors occurred during the scripted experience",
      evidence: networkEvents.map((event) => `HTTP ${event.status} ${event.url}`).slice(0, 5).join("; "),
      suggestion: "Handle disabled services and expected empty states with 2xx responses, or route errors into user-facing recovery copy.",
      autoFixable: false,
      heuristic: "network-5xx",
    });
  }

  const blocking = findings.filter((item) => item.priority === "P0" || item.priority === "P1");
  const run = {
    goal,
    target: baseUrl,
    startedAt,
    persona,
    journeySet: { id: journeySet.id, name: journeySet.name },
    summary: {
      journeys: rows.length,
      passed: rows.filter((row) => row.ok).length,
      failed: rows.filter((row) => !row.ok).length,
      findings: findings.length,
      blockingFindings: blocking.length,
      consoleEvents: consoleEvents.length,
      networkEvents: networkEvents.length,
      healthChecks: healthChecks.length,
      passedHealthChecks: healthChecks.filter((item) => item.ok).length,
      coreWorkflowSteps: coreWorkflows.length,
      passedCoreWorkflowSteps: coreWorkflows.filter((item) => item.ok).length,
    },
  };

  await Promise.all([
    writeFile(join(outDir, "run.json"), JSON.stringify(run, null, 2)),
    writeFile(join(outDir, "journeys.json"), JSON.stringify(rows, null, 2)),
    writeFile(join(outDir, "findings.json"), JSON.stringify(findings, null, 2)),
    writeFile(join(outDir, "console.json"), JSON.stringify(consoleEvents, null, 2)),
    writeFile(join(outDir, "network.json"), JSON.stringify(networkEvents, null, 2)),
    writeFile(join(outDir, "health.json"), JSON.stringify(healthChecks, null, 2)),
    writeFile(join(outDir, "core-workflows.json"), JSON.stringify(coreWorkflows, null, 2)),
    writeFile(join(outDir, "transcript.md"), transcript.join("\n")),
    writeFile(join(outDir, "report.md"), renderReport({ run, rows, findings, consoleEvents, networkEvents, healthChecks, coreWorkflows })),
  ]);

  console.log(`UX audit written to ${join(outDir, "report.md")}`);
  console.log(`Structured findings written to ${join(outDir, "findings.json")}`);

  if (rows.some((row) => !row.ok) || blocking.length) process.exitCode = 1;
}

const args = parseArgs(process.argv);
if (args.command === "audit") {
  await runAudit(args);
} else if (args.command === "review") {
  await runReview(args);
} else if (args.command === "visual") {
  await runVisual(args);
} else {
  console.error(`Unknown command: ${args.command}`);
  process.exit(2);
}
