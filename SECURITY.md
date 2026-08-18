# Security Policy

## Supported versions

Security fixes are applied to the latest release and `main`.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository. Include:

- affected component and version or commit
- impact and preconditions
- minimal reproduction
- whether Telegram credentials, local authority files, or root helper boundaries are involved

Please do not include live bot tokens, chat IDs, session transcripts, or private configuration.

## Security model

The project deliberately separates:

- public source code
- user-owned Telegram credentials and allowlists
- root-owned reset configuration and helper installation
- versioned runtime releases

The MCP tools expose bounded operations. They do not accept arbitrary shell commands or arbitrary Telegram Bot API methods.
