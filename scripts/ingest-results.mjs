import { findRun, ingestResultFiles, runs } from "../server.js";

function optionValue(args, name, fallback) {
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  return match.slice(prefix.length);
}

const args = process.argv.slice(2);
const runId = optionValue(args, "--run", null);
const targetId = optionValue(args, "--target", "codenext");
const force = args.includes("--force");

const run = runId
  ? findRun(runId)
  : runs().find((candidate) => candidate.targetId === targetId);

if (!run) {
  process.stderr.write(`No Steve run found for ${runId || targetId}\n`);
  process.exitCode = 1;
} else {
  const result = ingestResultFiles(run, { force });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
