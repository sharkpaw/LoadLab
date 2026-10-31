<div align="center">

**English** · [Türkçe](README.tr.md)

<img src="docs/logo.svg" alt="LoadLab logo" width="120">

# LoadLab

**Know how much traffic your site can take.**<br>
A self-hosted load-testing platform built on [k6](https://github.com/grafana/k6): model real user journeys, run them at any scale, watch results live and keep a performance history for every site. AI agents can also draft and analyse tests for you over MCP.

[![CI](https://github.com/sharkpaw/LoadLab/actions/workflows/ci.yml/badge.svg)](https://github.com/sharkpaw/LoadLab/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sharkpaw/LoadLab?label=release&color=2fbf8f)](https://github.com/sharkpaw/LoadLab/releases)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
![k6](https://img.shields.io/badge/powered%20by-k6-7d64ff)
![Docker](https://img.shields.io/badge/deploy-Docker%20Compose%20%7C%20Coolify-2496ed)

[Features](#features) · [Screenshots](#screenshots) · [Quick start](#quick-start) · [Deploy on Coolify](#deploy-on-coolify) · [MCP](#use-it-with-ai-agents-mcp) · [Contributing](#contributing)

<img src="docs/demo.gif" alt="LoadLab tour: sign in, edit a workflow, start a test, watch it live, stop it, check the breakpoint result, the site benchmark and the MCP setup" width="900">

</div>

---

## Why LoadLab?

k6 is a great engine, but a script per test and a terminal full of numbers don't scale to a team or to a dozen sites. LoadLab puts a product around it:

- 🧭 **Real user journeys, not URL lists.** Build flows like *visit → open a random product → 30% sign in → 10% buy* in a visual editor, with probabilities, loops, variables and shared modules.
- 📈 **Live results you can act on.** Watch users, requests/s, p50/p95/p99 and errors second by second. You can stop or force-stop any test.
- 💥 **Find the breaking point.** A breakpoint test keeps raising the load and stops itself when p95 or the error rate crosses your limit. It then reports the highest healthy throughput.
- 🗂️ **A benchmark history per site.** Compare runs, mark a baseline and track p95 and capacity over time to catch regressions.
- 🤖 **Built for AI agents (MCP).** Claude, Gemini, ChatGPT, Cursor or any other MCP client can inspect your site, draft workflows and test plans, debug them and read the results. You review the draft and press **Start**.
- 🔒 **Secure by default.** Better Auth with 2FA, rate-limited sign-in, no public sign-up, and tests that can only reach the hosts you registered.
- 🧮 **Know your own footprint.** See LoadLab's CPU, memory, database and disk usage, with a warning when the load generator, not your site, is the bottleneck.
- 🌐 **Multilingual dashboard:** English and Turkish, switchable at any time.

## Features

### Workflows
- **Visual flow editor** with step types: `page` (HTML plus its CSS/JS/images), `request` (any API call with JSON/form/raw body), `think` (user pause), `set` (variables), `group` (probability + repeat) and `include` (shared module, e.g. *Sign in*).
- **Checks** (status, body contains, JSON path, max duration, header) and **extraction** from JSON, HTML (CSS selectors), regex, headers or cookies. Each can pick the first, a random or every match.
- **Templates** such as `{{productId}}`, `{{data.users.email}}` (per-user datasets), `{{$randomInt 1 10}}`, `{{$uuid}}` and `{{$randomItem list}}`.
- **Debug run:** 1 user, 1 iteration, with status, timing, extracted variables and a response preview for every step.
- **HAR import:** record yourself in the browser and get a draft workflow, with pauses turned into think time.
- Version history, JSON view, built-in DSL guide and a page inspector that lists a page's links and forms.

### Test plans and profiles
Mix several workflows by weight and pick a profile:

| Profile | Use it for |
|---|---|
| Smoke | Does the flow work at all? |
| Constant users / Constant rate | Steady load by concurrency or by arrivals per second |
| Ramp-up · Stress · Spike | Staged load shapes (editable stages, live preview) |
| Soak | Hours of steady load: leaks and slow degradation |
| **Breakpoint** | Ramps the arrival rate until p95 or errors cross your limit, then reports capacity |

Plans also get pass/fail thresholds (p95, p99, error rate, check rate), auto-stop rules and optional cron schedules for nightly benchmarks.

**Distributed runs:** set *Workers* in a plan's advanced options to split one test across several workers when a single worker's CPU is the limit. Each worker runs an equal share of the VUs and rate (k6 execution segments), all of them start from a paused state at the same moment, and the lead worker merges their results into one run: the same live charts, per-step table and summary, plus a per-worker table. A distributed test waits in the queue until enough workers are free; if a worker drops out mid-test, the run stops and keeps what was measured.

### Runs
- Live charts over Server-Sent Events, a per-step latency table and status codes, plus a breakdown of where users dropped out.
- **Stop** (graceful) and **Force stop**, queue cancellation and re-run.
- Compare any two runs, or a run against the site's baseline.

## Screenshots

| Overview | Workflow editor |
|---|---|
| <img src="docs/images/dashboard-en.jpg" alt="Overview" width="440"> | <img src="docs/images/workflow-en.jpg" alt="Workflow editor" width="440"> |
| **Breakpoint result** | **Test plan** |
| <img src="docs/images/breakpoint-en.jpg" alt="Breakpoint capacity" width="440"> | <img src="docs/images/plan-en.jpg" alt="Test plan editor" width="440"> |
| **Site benchmark** | **System resources** |
| <img src="docs/images/benchmark-en.jpg" alt="Benchmark history" width="440"> | <img src="docs/images/system-en.jpg" alt="System resources" width="440"> |
| **Sign in** | **Settings & MCP** |
| <img src="docs/images/login-en.jpg" alt="Sign-in page" width="440"> | <img src="docs/images/settings-en.jpg" alt="Settings and MCP" width="440"> |

## Quick start

Requirements: Docker with Compose v2.

```bash
git clone https://github.com/sharkpaw/LoadLab.git && cd LoadLab
cp .env.example .env
```

Fill in the three secrets in `.env`, for example with `openssl rand -hex 32`:

```bash
SERVICE_PASSWORD_POSTGRES=...   # database password
SERVICE_HEX_64_AUTH=...         # session secret (64 hex chars)
SERVICE_PASSWORD_ADMIN=...      # first admin password, min. 10 characters
```

```bash
docker compose up -d --build
```

Open <http://localhost:8080> and sign in as `admin@example.com` (or your `ADMIN_EMAIL`). Then:

1. **Add a site.** Enter the base URL of a system you own, plus any extra hosts it may call.
2. **Create a workflow** from a template or a HAR file, and check it with **Debug run**.
3. **Create a test plan.** Pick workflows, a profile and thresholds, then press **Start**.

> ⚠️ Only test systems you own or are explicitly allowed to test. LoadLab generates real traffic.

## Deploy on Coolify

`docker-compose.yml` follows Coolify's conventions: `expose` instead of ports, and auto-generated `SERVICE_*` secrets.

1. **New Resource → Git repository → Docker Compose**, pointing at this repository.
2. Assign a domain to the **loadlab** service: `https://loadlab.example.com:8080`. The `:8080` is the internal port the proxy routes to.
3. Set `ADMIN_EMAIL`. Coolify generates `SERVICE_PASSWORD_POSTGRES`, `SERVICE_HEX_64_AUTH` and `SERVICE_PASSWORD_ADMIN`; your first password is `SERVICE_PASSWORD_ADMIN`.
4. Deploy, sign in, then change your password and enable 2FA under **Settings**.

Prebuilt multi-arch images are published to `ghcr.io/sharkpaw/loadlab` for every release.

## Use it with AI agents (MCP)

LoadLab speaks the open [Model Context Protocol](https://modelcontextprotocol.io), so it works with any MCP client that supports Streamable HTTP: Claude, Gemini CLI, ChatGPT, Codex, Cursor, VS Code, Windsurf and others. Pick one of two ways to sign in. **Settings & MCP** shows copy-ready setup for both.

**OAuth (recommended):** add just the server URL. The client discovers LoadLab's OAuth 2.1 server, opens the sign-in page in your browser, and you approve it on a consent screen. Behind this are dynamic client registration and PKCE, and tokens are bound to your `/mcp` resource.

```bash
claude mcp add --transport http loadlab https://loadlab.example.com/mcp
gemini mcp add --transport http loadlab https://loadlab.example.com/mcp
codex mcp add loadlab --url https://loadlab.example.com/mcp
```

For ChatGPT or Claude.ai connectors, paste `https://loadlab.example.com/mcp` as the server URL.

**API key:** for clients without OAuth, or for scripts. Create a key under **Settings & MCP**:

```bash
claude mcp add --transport http loadlab https://loadlab.example.com/mcp --header "Authorization: Bearer ll_..."
```

Clients that can neither do OAuth nor send headers can use `https://loadlab.example.com/mcp?token=ll_...`. Keep that URL private, because the key is part of it. OAuth needs an HTTPS `PUBLIC_URL` (plain HTTP only on `localhost`); turn it off with `MCP_OAUTH=false`.

LoadLab exposes 25 tools: inspect a page, create, update or debug workflows, draft test plans, read run results and time series, compare runs, view site benchmarks and check system status. Everything an agent creates arrives as a **draft** under *Drafts awaiting review*. Letting MCP start tests directly requires `MCP_ALLOW_RUN=true`, which is off by default.

Example prompts:
- *"Inspect my shop's home page and draft a workflow that opens a random product, where 30% sign in and 10% add to cart. Verify it with a debug run."*
- *"Draft a breakpoint test with these workflows in a 70/30 mix that stops at p95 1 s or 2% errors."*
- *"Compare the last two stress tests. Which step got slower?"*

## How it works

```
 Browser ─────▶ api (Bun + Fastify) ─ dashboard · REST · SSE · /mcp · Better Auth
 AI agent (MCP) ▶   │ queue: Postgres (SKIP LOCKED) + Redis wake-up
                     ▼
               worker ×N (Bun) ── k6 + runner.js ─────────▶ your site
                     │ k6 JSON output (FIFO) → per-second buckets, per-step histograms
                     ▼
               Postgres + Drizzle (sites, workflows, plans, runs, metrics, auth)
               Redis (live stream, stop signals, session cache, rate limits)
```

- k6 runs **one generic script** (`server/k6/runner.js`) that interprets the workflow JSON. No code is generated per test.
- Each worker runs one test at a time for clean measurements. Scale out with `WORKER_REPLICAS`: more tests in parallel, or one test split across workers (*Workers* in the plan). Workers on other machines can join as long as they reach the same Postgres and Redis.
- The worker tracks k6's own CPU and warns when the load generator saturates or when iterations are dropped.

## Security

- **Authentication:** Better Auth with email + password (min. 10 chars), TOTP two-factor with backup codes, session list and remote sign-out, in-app password change.
- **Forgot password:** reset links are valid for 30 minutes and work only once, and resetting signs out every session and sends a "password changed" notice. The form never reveals whether an e-mail exists. Without SMTP, the link is printed to the API log for an administrator.
- **Hardening:** public sign-up is disabled, and sign-in, 2FA and password-reset attempts are rate-limited in Redis. State-changing requests get an origin check, and deleting a user revokes their cached sessions too. CSP, HSTS (on HTTPS) and `X-Frame-Options` are set.
- **Target safety:** tests can only reach the site's base URL host and its `allowedHosts`. This is enforced both when a plan is compiled and inside k6 at runtime. VUs, rate and duration are capped by `MAX_VUS`, `MAX_RATE` and `MAX_DURATION_SEC`.
- **MCP access:** OAuth 2.1 with PKCE, explicit consent and tokens bound to the `/mcp` resource, or revocable API keys stored only as SHA-256 hashes.

### Admin CLI (server terminal)

For when nobody can sign in, or someone lost their phone:

```bash
docker compose exec loadlab bun src/cli.ts users
docker compose exec loadlab bun src/cli.ts reset-password admin@example.com   # prints a new random password
docker compose exec loadlab bun src/cli.ts disable-2fa user@example.com
docker compose exec loadlab bun src/cli.ts revoke-sessions user@example.com
docker compose exec loadlab bun src/cli.ts create-user ops@example.com --name Ops
```

On Coolify, use the **loadlab** container's terminal and run the same `bun src/cli.ts …` commands.

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Configuration

All variables are validated at startup with [t3-env](https://github.com/t3-oss/t3-env) and zod. If a required one is missing or invalid, the container exits and lists every problem instead of starting half-configured.

| Variable | Default | Description |
|---|---|---|
| `SERVICE_PASSWORD_POSTGRES` | — (required) | Postgres password (generated by Coolify) |
| `SERVICE_HEX_64_AUTH` | — (required) | Better Auth secret (generated by Coolify) |
| `SERVICE_PASSWORD_ADMIN` | — (required) | First admin password; only used while there are no users |
| `ADMIN_EMAIL` | `admin@example.com` | First admin's email |
| `PUBLIC_URL` | `SERVICE_URL_LOADLAB` | Public URL of the dashboard (cookies, origin checks, MCP links) |
| `TRUSTED_ORIGINS` | — | Extra dashboard origins, comma-separated |
| `TRUST_PROXY_HOPS` | `1` | Reverse proxies in front of the API (`0` if exposed directly) |
| `WORKER_REPLICAS` | `1` | Number of workers: tests that can run in parallel, and the most a single test can be split across |
| `MAX_VUS` / `MAX_RATE` / `MAX_DURATION_SEC` | 5000 / 20000 / 14400 | Safety caps |
| `MCP_ALLOW_RUN` | `false` | Allow MCP clients to start tests |
| `MCP_ALLOW_DEBUG` | `true` | Allow MCP clients to start 1-iteration debug runs |
| `MCP_OAUTH` | `true` | OAuth 2.1 sign-in for MCP clients (needs an HTTPS `PUBLIC_URL` or localhost) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — / 587 / false | Optional SMTP for password-reset mail. Without it, reset links go to the API log (`docker compose logs loadlab \| grep "reset link"`) |
| `TZ` | `UTC` | Time zone (cron schedules) |

## Development

```bash
cd server && bun install && bun run typecheck && bun run test
cd web && bun install && bun run dev     # http://localhost:5173, proxies to :8080
```

- **Stack:** Bun · Fastify 5 · Drizzle ORM (Postgres) · Redis · Better Auth · React 19 · Vite · Tailwind 4 · Recharts · k6.
- **Database:** `server/src/db/schema.ts` is the single source of truth. After changing it, run `bun run db:generate --name <change>`. Migrations apply automatically on startup.
- **Translations:** UI text goes through `t('…')`, and `bun run i18n:check` makes sure every string has a Turkish entry.
- **Tests:** unit tests run with `bun run test`. CI also boots the whole stack in Docker and runs an end-to-end smoke test (`server/test/e2e/smoke.ts`) with real k6 runs.

Project layout and conventions: [AGENTS.md](AGENTS.md).

## Roadmap

| | |
|---|---|
| ✅ | Visual workflow editor, shared modules, HAR import, debug runs |
| ✅ | Load profiles including breakpoint / capacity detection |
| ✅ | Live charts, stop / force stop, run comparison, site benchmarks |
| ✅ | MCP server for drafting and analysing tests with any AI agent |
| ✅ | Better Auth with 2FA, password reset (SMTP or log) and an admin CLI |
| ✅ | English and Turkish UI |
| ✅ | Coolify-ready compose, multi-arch images, CI with end-to-end tests |
| ✅ | Distributed runs (one test across several workers) |
| ⬜ | Browser-level steps (k6 browser) for front-end metrics |
| ⬜ | Notifications (Slack / e-mail / webhooks) on threshold failures |
| ⬜ | More languages (contributions welcome) |

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

- 🐞 [Report a bug](https://github.com/sharkpaw/LoadLab/issues/new?template=bug_report.yml)
- ✨ [Request a feature](https://github.com/sharkpaw/LoadLab/issues/new?template=feature_request.yml)
- 🔧 Fork, branch and open a pull request to `main`. CI runs type checks, unit tests, the translation check and a full Docker + k6 end-to-end test.

## License

LoadLab is released under the [Apache License 2.0](LICENSE).

The Docker image bundles the unmodified [k6](https://github.com/grafana/k6) binary by Grafana Labs, which is licensed under AGPL-3.0 and runs as a separate program; see [NOTICE](NOTICE). LoadLab is not affiliated with Grafana Labs.
