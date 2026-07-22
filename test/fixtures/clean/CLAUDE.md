# Project rules

See @docs/style.md for formatting conventions.

- Never write to `secrets/` (blocked in settings). <!-- enforced-by: deny Write(./secrets/**) -->
- Always run the linter after edits. <!-- enforced-by: script lint-check.mjs -->
- Prefer small commits over large ones.
