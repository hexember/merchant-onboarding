# CLAUDE.md

Project overview and commands: [README.md](README.md). Design source of truth: [docs/adrs/](docs/adrs/), one file per area (workflow, database, kyb-check, auth, sensitive-data, testing); read the relevant file before changing that area. Rules live in `.claude/rules/`: security and
general rules always apply, the others load for matching paths.

## Workflow

- If a change conflicts with an ADR in `docs/adrs/`, flag it first. Update that ADR in the same change.
- Run `/verify` before calling anything done. Report failures honestly.
- Don't commit or push unless asked. Running `/ship <task>` counts as asking for that task.
