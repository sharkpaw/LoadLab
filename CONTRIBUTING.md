# Contributing to LoadLab

Thanks for helping! Bug reports, ideas, translations and code are all welcome.

## Before you start

- For bigger changes, open an issue first so we can agree on the approach.
- Security issues: please report them privately (see [SECURITY.md](SECURITY.md)).

## Development setup

You need [Bun](https://bun.sh) 1.4+ and Docker.

```bash
cp .env.example .env           # fill in the SERVICE_* values
docker compose up -d --build   # Postgres, Redis, API and a worker on http://localhost:8080
cd web && bun install && bun run dev   # hot-reloading dashboard on :5173
```

Project layout, commands and conventions are in [AGENTS.md](AGENTS.md).

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep the change focused; add or update tests where it makes sense (`server/test/`).
3. Run the checks locally:
   ```bash
   cd server && bun run typecheck && bun run test
   cd web && bun run build && bun run i18n:check
   ```
4. Database changes: edit `server/src/db/schema.ts` and run `bun run db:generate --name <change>`. Commit the generated migration.
5. UI text: wrap it in `t('…')` and add the Turkish translation to `web/src/locales/tr.ts`.
6. Open a pull request against `main`. CI runs type checks, unit tests, the translation check, the build and an end-to-end test with Docker and k6.

## Adding a language

1. Copy `web/src/locales/tr.ts` to `web/src/locales/<code>.ts` and translate the values.
2. Register it in `web/src/lib/i18n.tsx` (`LANGUAGES`, `DICTS`, `locale()`).
3. Extend `web/scripts/check-i18n.ts` to check the new dictionary.

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
