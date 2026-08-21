# Working on this repository

This kit exists so that a model chooses nothing about Telegram delivery or session
control. Hooks and deterministic code decide; Claude only returns canonical Markdown.
Most changes that look like improvements erode that property. Read
[`docs/design-invariants.md`](docs/design-invariants.md) before proposing one.

## Do not

- Add a model-facing tool. Transport selection, quote target, fallback, reactions,
  artifact discovery, and disclosure redaction are deterministic and stay that way.
  Any new model-facing surface requires an explicit design-invariant change and security
  review before implementation.
- Retry an uncertain outcome, or convert one into a failure. A timeout, 429, 5xx, or
  unknown response leaves state untouched and leaves `👀` in place. Only proven local
  or permanent rejection may finalize `👎`.
- Weaken a filesystem check. Preserve directory-FD anchoring, owner, mode, inode, and
  link-count verification wherever the current boundary uses them. Do not replace those
  checks with a bare path, `realpath`, or a single `stat`.
- Give the unprivileged side privileged authority. It never executes `sudo`,
  `systemd-run`, helper or config paths, unit names, or arbitrary argv. Privileged work
  crosses the peer-UID-checked broker socket and nothing else.
- Commit real deployment identity. Paths, chat IDs, bot usernames, and tokens stay out
  of the tree. `scripts/check_public_tree.py` is a backstop, not a substitute for care.

## Do

- Run `bun run check` before claiming anything works. It covers tests, typecheck,
  Python compile and unit tests, the privacy scan, and version agreement.
- Version each wire contract explicitly. A Broker Protocol request/response change must
  update the TypeScript client and root broker together; a Session Control Protocol or
  helper CLI contract change must update the broker capability expectation and helper
  together.
- Keep the two envelope parsers in sync through
  `packages/shared/fixtures/telegram-envelope-cases.json`. The command guard must never
  allow a direct control envelope that the strict TypeScript parser accepts to fall
  through to the model.
- Change release versions in one operation. Four `package.json` files, `bun.lock`, and
  both `src/server.ts` identities must match; `scripts/check_versions.py` enforces the
  source identities.
