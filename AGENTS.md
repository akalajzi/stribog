# Stribog

- Intended to be open-sourced. Never commit real network data: `data/` and `stribog.config.json` are git-ignored and hold the owner's exports, sample state and overrides. Fixtures, tests and screenshots use the fictional demo network in `fixtures/demo` (RFC 5737/7042 addresses).
- Stribog is read-only by design. Do not add code that writes to a router; fixes are scripts for the user to review and paste.
- Keep secrets out of everything: the parser and REST collector scrub passphrase/password/key fields; never log or store router credentials outside the user's own password file.
- Commits use the personal identity (`akalajzi@gmail.com`), already set in this repo's git config.
- Run `pnpm test` and `pnpm typecheck` before committing. Check UI changes with a screenshot of the running dev server (`pnpm dev`, port 4517).
- Design rules: colour and motion carry data only; plain English with jargon explained; every inferred fact is shown as such.
