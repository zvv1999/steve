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

For a product-manager style hands-on review, use:

```bash
CODEX_UX_PASS=admin123 npm run example:codenext:review
```

For a Playwright visual score pass on the Skill Hub, use:

```bash
npm run example:codenext:visual
```

The visual pass captures desktop/mobile screenshots, checks console and failed requests, scores horizontal overflow, small click targets, scenario navigation, grouped official skills, search match reasons, and writes a Chinese report. For enterprise sessions, pass a Netscape cookie jar:

```bash
STEVE_COOKIE_JAR=/tmp/codenext-local-cookiejar npm run example:codenext:visual
```

`audit` answers "did the scripted paths pass?".

`review` answers "what did the product feel like, what broke the experience, and where should it evolve next?" It writes product test plans, hands-on observations, screenshots, findings, and evolution directions.

`visual` answers "does the UI feel polished enough to pass a score threshold?" It is meant to run after Codex repairs the product and before it writes the final report.

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

Product reviews write:

```text
artifacts/product-experience-review/
  plans.json
  observations.json
  findings.json
  console.json
  network.json
  report.md
  screenshots/
```

Visual scores write:

```text
artifacts/visual-score-skillhub/
  report.json
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
  reviews/product.json
  heuristics/default.json
```

`persona` describes who the agent is pretending to be.

`journeys` describes repeatable user paths.

`heuristics` describes product smoothness rules such as dead ends, internal leaks, implementation-detail copy, missing CTAs, and console errors.

`reviews` describes product test plans, success signals, hands-on workflow scope, and evolution-oriented findings.

## License

MIT
