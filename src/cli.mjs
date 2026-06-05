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

function short(text, max = 260) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
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
  const { baseUrl, screenshotDir, heuristics, rows, findings, transcript } = context;
  const url = new URL(journey.path, baseUrl).toString();
  const screenshot = `${safeFileName(journey.name)}.png`;
  const row = {
    id: journey.id,
    name: journey.name,
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

  await page.screenshot({ path: join(screenshotDir, screenshot), fullPage: true }).catch((error) => {
    row.notes.push(`Screenshot failed: ${error.message}`);
  });

  row.preview = short(text);
  transcript.push(`Visible text: ${row.preview}\nActions: ${JSON.stringify(actions)}\nScreenshot: ${row.screenshot}\n`);
  rows.push(row);
}

function renderReport({ run, rows, findings, consoleEvents }) {
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
    "",
    "## Journey Results",
    "",
    "| Area | Status | Evidence | Screenshot |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => {
      const status = row.ok ? "PASS" : "FAIL";
      const evidence = row.missing.length ? `Missing: ${row.missing.join(", ")}` : row.notes.join("; ") || row.preview;
      return `| ${row.name} | ${status} | ${evidence.replaceAll("|", "\\|")} | ${row.screenshot} |`;
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
      });
    }
  } finally {
    await browser.close();
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
    },
  };

  await Promise.all([
    writeFile(join(outDir, "run.json"), JSON.stringify(run, null, 2)),
    writeFile(join(outDir, "journeys.json"), JSON.stringify(rows, null, 2)),
    writeFile(join(outDir, "findings.json"), JSON.stringify(findings, null, 2)),
    writeFile(join(outDir, "console.json"), JSON.stringify(consoleEvents, null, 2)),
    writeFile(join(outDir, "network.json"), JSON.stringify(networkEvents, null, 2)),
    writeFile(join(outDir, "transcript.md"), transcript.join("\n")),
    writeFile(join(outDir, "report.md"), renderReport({ run, rows, findings, consoleEvents })),
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
