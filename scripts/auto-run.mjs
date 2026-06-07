import { autoRunTarget, mergePlan } from "../server.js";

const args = process.argv.slice(2);
const targetId = args.find((arg) => !arg.startsWith("--")) || "codenext";
const notifyCurrentCodex = !args.includes("--no-notify-current-codex");
const run = await autoRunTarget(targetId, {
  notifyCurrentCodex,
  notificationReason: "CLI auto-run completed; notify current Steve work Codex to update and restart task execution.",
});
const visualItem = run.items.find((item) => item.id === "visual-quality-score");
const handoffs = run.items.filter((item) => (
  item.codexSessions?.some((session) => session.mode === "app-handoff")
));

process.stdout.write(`${JSON.stringify({
  ok: true,
  runId: run.id,
  targetId: run.targetId,
  status: run.status,
  visualScore: visualItem?.visualScore || null,
  handoffCount: handoffs.length,
  coordinationPath: run.coordinationPath || null,
  runContextPath: run.runContextPath || null,
  currentCodexNotification: run.currentCodexNotification || null,
  mergePlan: mergePlan(run),
}, null, 2)}\n`);
