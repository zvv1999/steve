# Steve

Steve is a standalone product experience agent workbench.

It is intentionally separate from product repositories. A product such as CodeNext is configured as a target, while Steve keeps its own runs, reports, and candidate worktrees outside the target repo's product code.

## Run

```bash
PORT=3610 npm start
```

Open:

```text
http://127.0.0.1:3610
```

## Target Model

Targets live in `config/targets.json`.

Each target defines:

- `root`: the target git repo.
- `appUrl`: the local product URL Steve should experience.
- `baseBranch`: the branch Steve branches from.
- `worktreeDir`: where Steve-created worktrees live.

Steve can manage multiple targets without adding UI or API code to those targets.

## Product Repository Privacy

Steve must keep orchestration details out of product repositories.

For a target such as CodeNext, the product repo is user-facing and collaborator-facing. Steve may keep run ids, worker ids, handoff files, worktree paths, reports, and user request context inside the Steve repo, but it must not expose those details through the product repo's Git refs, commit messages, PR titles, docs, UI text, or release notes.

Target config supports:

```json
"gitPrivacy": {
  "noNamedWorkerBranches": true,
  "sanitizeProductCommits": true,
  "hideSteveInternalsFromCollaborators": true
}
```

When `noNamedWorkerBranches` is enabled, Steve creates detached worktrees instead of named branches such as `steve/codenext/<run>/<worker>`. Product commits should describe only the product change, for example `fix: improve skill hub layout`, not Steve's run, worker, validation chain, or the user's private prompt.

## Codex App Handoff

Steve does not assume a Codex CLI exists in the target environment.

The default executor is `app-handoff`:

1. Steve creates an external worktree for a candidate item.
2. Steve writes a `context.md` handoff pack under `.steve/runs/<run>/<item>/`.
3. Steve marks the item as `handoff-ready`.
4. The current Codex App session, or a future Codex App integration, can pick up that context, fork or spawn sessions, do the work, and report back through Steve's run/item state.

Optional CLI execution is only an adapter:

```bash
STEVE_CODEX_EXECUTOR=cli CODEX_BIN=/path/to/codex npm start
```

For product use, prefer `app-handoff` so Steve remains pluggable with the current Codex App workflow.

## Codex App Operator Loop

Steve's primary execution model is a real Codex App operator loop:

- **Steve** is the master agent session. It owns the product goal, target context, queues, quality gates, reports, and iteration decisions.
- **Codex App Operator** is the current signed-in Codex App session. It reads Steve's inbox, claims work, spawns real Codex workers, waits for results, and keeps a heartbeat.
- **Workers** are independent Codex agents. Each worker receives one focused prompt, may research high-star GitHub projects when useful, works in its own context/worktree, and writes a `handoff-result` back to Steve.

The HTTP control surface is:

```text
GET  /api/codex/operator
POST /api/codex/operator
POST /api/codex/operator/heartbeat

GET  /api/codex/operator/inbox?targetId=codenext
POST /api/codex/operator/loop
GET  /api/codex/operator/loop
POST /api/codex/operator/loop/tick

POST /api/runs/<run>/items/<item>/operator-claim
POST /api/runs/<run>/items/<item>/handoff-result
```

The loop contract:

1. Steve creates or discovers candidate work and exposes it in `operator/inbox`.
2. The Codex App Operator reads `readyToClaim`.
3. The Operator claims one item with `operator-claim`; only then does it become `running`.
4. The Operator spawns a real Codex worker and passes the `workerPrompt` from inbox.
5. The worker calls `handoff-result` with a Chinese report, score, recommendation, evidence, verification, and `nextWorkers`.
6. Steve ingests the result. If the score is below `100` or the worker returns `nextWorkers`, Steve materializes those next workers into fresh `handoff-ready` tasks.
7. The Operator ticks again and continues until the queue is truly empty.

The web console can start/pause/tick the loop and add heuristic directions, but it does not pretend work is running. A worker is marked busy only after the current Codex App Operator claims it and a real Codex worker is spawned from this session.

When no `readyToClaim` or `running` tasks remain, an active loop with `autoDiscover=true` creates a discovery worker from the current directive so Steve keeps finding valuable product-experience work instead of going idle.

## Multi-Codex Context Graph

Every auto run is coordinated by Steve and executed by multiple Codex App workers.

Steve writes two run-level files:

- `.steve/runs/<run>/run-context.md`: the shared parent context all workers should read first.
- `.steve/runs/<run>/coordination.json`: the worker graph, context paths, result paths, status, dependencies, visual baseline, target health snapshot, night window, and morning recovery queue.

Each worker also receives its own item-level handoff pack:

- `.steve/runs/<run>/<item>/context.md`
- `.steve/runs/<run>/<item>/result.md`
- `.steve/runs/<run>/<item>/codex.jsonl`

The intended loop is:

1. Steve runs visual scoring and registers several Codex App handoffs.
2. Each Codex worker reads the shared run context plus its item context.
3. Before work starts, the worker decides whether the task needs a skill. If it does, the worker discovers or selects a suitable skill and records why that skill improves precision.
4. Workers operate in isolated external worktrees.
5. Workers return Chinese reports through the handoff result endpoint.
6. Steve refreshes the coordination graph, report, and next-step candidates.

Steve treats 100 points as the acceptance gate for a candidate, not as the end of the loop. A candidate is not accepted until product-flow verification, visual verification, regression checks, a Chinese why-it-matters report, and a merge/continue/abandon recommendation are all present. If the candidate is below 100, Steve should create the next focused worker handoff and keep optimizing. If every current candidate reaches 100, Steve should discover the next batch of high-value product, verification, or feature opportunities and keep going.

Worker recommendations are input evidence, not final authority. After workers finish, a post-worker quality controller reads `coordination.json`, all `result.md` files, changed paths, tests, visual reports, and service status. Only this quality controller can promote a candidate to merge-ready. Its output must also include the next worker handoffs so the loop never becomes idle.

Morning recovery is intentionally decision-first:

- `merge` is shown as ready only when `qualityScore` is exactly `100`, a result exists, and the worker supplied evidence.
- `needs-polish` keeps the item in the continuation queue.
- `needs-human` separates ambiguous choices from merge-ready work.
- `reject`/`abandon` keeps the branch out of the merge queue.

Result ingestion endpoint:

```text
POST /api/runs/<run>/items/<item>/handoff-result
```

Minimal body:

```json
{
  "summary": "中文结论",
  "report": "# 中文报告...",
  "recommendation": "merge",
  "qualityScore": 100,
  "evidencePaths": [".steve/runs/<run>/<item>/result.md"],
  "changedPaths": ["server.js", "public/app.js"],
  "verification": {
    "productFlow": "不适用：本次只改 Steve 编排协议",
    "visual": "已在 Steve 看板复核",
    "regression": "npm run check 通过"
  },
  "dependsOn": ["visual-quality-score"],
  "nextWorkers": ["mobile-regression"]
}
```

## Current Codex Restart Notification

Automation runs can continue without starting the Steve HTTP server:

```bash
node scripts/auto-run.mjs codenext
```

After each CLI auto-run, Steve notifies the current Steve work Codex through:

- `.steve/codex/latest-notification.json`
- `.steve/codex/restart-request.json`
- `.steve/codex/latest.md`
- `.steve/codex/notifications.jsonl`

The notification tells the current Codex worker which run context and coordination plan to reload, and which `handoff-ready` or `needs-polish` tasks should be restarted. Use `--no-notify-current-codex` only for local smoke tests that should not wake the current work loop.

If a Codex App worker wrote `result.md` but could not call the HTTP handoff endpoint, ingest the result files directly:

```bash
node scripts/ingest-results.mjs --target=codenext
node scripts/ingest-results.mjs --run=steve-... --force
```

This refreshes `.steve/runs.json`, `run-context.md`, and `coordination.json` from existing Steve result files without touching the target product repository.

## Current Codex Watchdog

Steve can also monitor whether the current Steve work Codex is actually moving. If a run stays on pending handoff work for too long, the watchdog writes a nudge and refreshes the restart request:

```bash
node scripts/watch-current-codex.mjs --target=codenext --idle-minutes=10
```

Useful variants:

```bash
node scripts/watch-current-codex.mjs --force
node scripts/watch-current-codex.mjs --auto-run
node scripts/watch-current-codex.mjs --loop --idle-minutes=10 --interval-minutes=5
```

Watchdog output is written under `.steve/codex/`:

- `latest-nudge.json`
- `latest-nudge.md`
- `nudges.jsonl`

The HTTP server exposes the same control surface:

```text
GET  /api/codex/watchdog?targetId=codenext&idleMs=600000
POST /api/codex/watchdog
```

## CLI Experience Examples

The repository also keeps the CLI-style product experience runner under `src/cli.mjs`.
It is useful when Steve needs repeatable browser journeys or visual scoring artifacts
without opening the Web control plane.

```bash
npm run example:codenext
npm run example:codenext:review
npm run example:codenext:visual
```

The CodeNext example configs live under `examples/codenext/`:

- `personas/default.json`: the user perspective for the run.
- `journeys/*.json`: repeatable product paths.
- `heuristics/default.json`: smoothness and dead-end checks.
- `reviews/product.json`: product review plans and success signals.
- `visual/skillhub.json`: visual scoring setup for the Skill Hub.

CLI outputs are written under `artifacts/`, which is intentionally ignored by Git.

## License

MIT
