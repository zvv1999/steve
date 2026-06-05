# Codex Product Experience Agent

A Codex-native product experience audit agent.

It is designed for this workflow:

```text
User product goal
  -> Codex chooses persona, journeys, and heuristics
  -> the experience agent runs repeatable browser journeys
  -> artifacts are written to disk
  -> Codex reads findings, repairs the product, reruns verification
  -> Codex writes the final product experience report
```

The agent does not make final product decisions. It acts as a temporary user-perspective executor and evidence collector. Codex remains the controller.

## Install

```bash
npm install
npx playwright install chromium
```

## Run The CodeNext Example

```bash
npm run example:codenext
```

Or with explicit options:

```bash
node src/cli.mjs audit \
  --config examples/codenext \
  --url http://127.0.0.1:3599 \
  --user admin \
  --pass admin123 \
  --out artifacts/ux-audit
```

For authenticated journeys, pass credentials explicitly with `--user` and `--pass`, or set:

```bash
CODEX_UX_USER=admin CODEX_UX_PASS=admin123 npm run example:codenext
```

## Output

Each run writes:

```text
artifacts/ux-audit/
  run.json
  journeys.json
  findings.json
  console.json
  network.json
  transcript.md
  report.md
  screenshots/
```

## Core Idea

The product experience agent follows Codex's work logic:

```text
delegate experience
  -> collect context
  -> repair under Codex control
  -> verify
  -> produce final report
```

## Configuration

Each product has a config directory:

```text
examples/codenext/
  personas/default.json
  journeys/default.json
  heuristics/default.json
```

`persona` describes who the agent is pretending to be.

`journeys` describes repeatable user paths.

`heuristics` describes product smoothness rules such as dead ends, internal leaks, implementation-detail copy, missing CTAs, and console errors.

## License

MIT
