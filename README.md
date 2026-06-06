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
