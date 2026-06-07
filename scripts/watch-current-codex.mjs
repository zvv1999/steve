import { monitorCurrentCodex } from "../server.js";

function optionValue(args, name, fallback) {
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  return match.slice(prefix.length);
}

const args = process.argv.slice(2);
const targetId = optionValue(args, "--target", "codenext");
const runId = optionValue(args, "--run", null);
const idleMinutes = Number(optionValue(args, "--idle-minutes", process.env.STEVE_WATCHDOG_IDLE_MINUTES || "10"));
const force = args.includes("--force");
const autoRunOnStall = args.includes("--auto-run");
const autoRunIfMissing = args.includes("--auto-run-if-missing");
const loop = args.includes("--loop");
const intervalMinutes = Number(optionValue(args, "--interval-minutes", process.env.STEVE_WATCHDOG_INTERVAL_MINUTES || "5"));

async function runOnce() {
  return monitorCurrentCodex({
    targetId,
    runId,
    idleMs: force ? 0 : Math.max(0, idleMinutes * 60_000),
    autoRunOnStall,
    autoRunIfMissing,
  });
}

if (!loop) {
  const result = await runOnce();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const intervalMs = Math.max(10_000, intervalMinutes * 60_000);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: "loop",
    targetId,
    runId,
    idleMinutes,
    intervalMinutes,
    autoRunOnStall,
    autoRunIfMissing,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  while (true) {
    const result = await runOnce();
    process.stdout.write(`${JSON.stringify({
      checkedAt: new Date().toISOString(),
      action: result.action,
      runId: result.runId,
      reason: result.reason,
      pendingItems: result.pendingItems?.length || 0,
      nudgeId: result.nudge?.id || null,
      restartedRunId: result.restartedRunId || null,
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
