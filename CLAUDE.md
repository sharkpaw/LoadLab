# CLAUDE.md

@AGENTS.md

## Claude-specific notes

- Read `AGENTS.md` first; it is the source of truth for layout, commands and conventions.
- Before finishing a change, run the relevant checks: `bun run typecheck && bun run test` in `server/`, `bun run build && bun run i18n:check` in `web/`.
- If you touch `server/src/db/schema.ts`, run `bun run db:generate --name <change>` and include the migration.
- To try the app end to end, use `docker compose up -d --build` and the smoke test in `server/test/e2e/smoke.ts`.
