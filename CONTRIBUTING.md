# Contributing

Thanks for helping improve Claude Code Telegram Kit.

## Development

Requirements:

- Linux
- Bun 1.3.14+
- Python 3.11+

```bash
bun install --frozen-lockfile
bun run check
bun audit
```

## Pull requests

- Keep private runtime data out of fixtures, logs, screenshots, and commits.
- Add a failing regression before changing behavior.
- Preserve fail-closed allowlist and no-resend semantics.
- Do not introduce an additional `getUpdates` consumer for the same bot token.
- Document configuration and rollback behavior.
- Keep public APIs generic; do not hard-code user names, bot names, chat IDs, home paths, or service names.

## Commit style

Use concise imperative subjects. Keep refactors and behavior changes separately reviewable when practical.

## Releases

Maintainers tag SemVer releases after CI passes on `main`. Local installations should reference an exact tag or commit SHA, never a floating branch.
