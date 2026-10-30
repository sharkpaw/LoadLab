# Security policy

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/sharkpaw/LoadLab/security/advisories/new) instead. Include steps to reproduce and the affected version or commit. We aim to reply within a few days.

## Scope notes

LoadLab generates real traffic. It is meant to be run by the owners of the target systems:

- Tests can only reach the hosts registered for a site (enforced at compile time and inside k6).
- Load is capped by `MAX_VUS`, `MAX_RATE` and `MAX_DURATION_SEC`.
- MCP clients can only create drafts unless `MCP_ALLOW_RUN=true`.

Only test systems you own or are explicitly authorized to test.
