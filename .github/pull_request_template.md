## What does this change?

<!-- A short description and the motivation. Link the issue if there is one: Closes #… -->

## How was it tested?

<!-- Unit tests, the e2e smoke test, manual steps in the dashboard… -->

## Checklist

- [ ] `bun run typecheck` and `bun run test` pass in `server/`
- [ ] Schema changes come with a migration (`bun run db:generate --name …`)
- [ ] New UI text uses `t('…')` and has a Turkish entry (`bun run i18n:check` in `web/`)
- [ ] Docs updated if behaviour changed (README / AGENTS.md)
