# Stribog

- Intended to be open-sourced. Never commit real network data: `data/` and `stribog.config.json` are git-ignored and hold the owner's exports and development snapshots; notes live in the data directory outside the repo. Fixtures, tests and screenshots use the fictional demo network in `fixtures/demo` (RFC 5737/7042 addresses).
- The web app signs in with the router's own user (usually admin), because home users will not create a separate one. The credentials live in server memory for the session only: never on disk, in logs, in API responses or in the browser.
- Writing to the router is planned, and only through one explicit flow: show the exact change, confirm, apply, read back to verify, with an automatic rollback for changes that could lock the user out. Until that flow exists, no code writes to a router; fixes are scripts for the user to review and paste.
- Stribog knows only what the router reports and what people or their agents write as notes. No knowledge of a particular network goes into code, defaults, fixtures or texts; inferences from router data are shown as such.
- Keep secrets out of everything: the parser and REST collector scrub passphrase/password/key fields.
- Commits use the personal identity (`akalajzi@gmail.com`), already set in this repo's git config.
- Run `pnpm test` and `pnpm typecheck` before committing. Check UI changes with a screenshot of the running dev server (`pnpm dev`, port 4517).
- Design rules: colour and motion carry data only; plain English with jargon explained; every inferred fact is shown as such.
