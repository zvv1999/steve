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

function renderReport({ run, rows, findings, consoleEvents, networkEvents, healthChecks }) {
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
    },
  };

  await Promise.all([
    writeFile(join(outDir, "run.json"), JSON.stringify(run, null, 2)),
    writeFile(join(outDir, "journeys.json"), JSON.stringify(rows, null, 2)),
    writeFile(join(outDir, "findings.json"), JSON.stringify(findings, null, 2)),
    writeFile(join(outDir, "console.json"), JSON.stringify(consoleEvents, null, 2)),
    writeFile(join(outDir, "network.json"), JSON.stringify(networkEvents, null, 2)),
    writeFile(join(outDir, "health.json"), JSON.stringify(healthChecks, null, 2)),
    writeFile(join(outDir, "transcript.md"), transcript.join("\n")),
    writeFile(join(outDir, "report.md"), renderReport({ run, rows, findings, consoleEvents, networkEvents, healthChecks })),
  ]);

  console.log(`UX audit written to ${join(outDir, "report.md")}`);
  console.log(`Structured findings written to ${join(outDir, "findings.json")}`);

  if (rows.some((row) => !row.ok) || blocking.length) process.exitCode = 1;
}

const args = parseArgs(process.argv);
if (args.command !== "audit") {
  console.error(`Unknown command: ${args.command}`);
  process.exit(2);
}

await runAudit(args);
