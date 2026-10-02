# Security

Expansion Radar is a local demo agent that can call paid third-party APIs and,
when explicitly requested, create a Mireye field request. Treat live mode as a
developer tool, not as a hosted production service.

## Secrets

- Copy `.env.example` to `.env` and keep `.env` local. The repository ignores
  `.env` and other `.env.*` files; `.env.example` is the only env file intended
  to be committed.
- Never put Mireye, Exa, LLM, cloud, or GitHub tokens in source code, fixtures,
  README examples, terminal transcripts, or issue comments.
- If a key is exposed, revoke or rotate it immediately with the provider and
  then remove it from the working tree and Git history as appropriate. Deleting
  the line alone is not enough to invalidate a leaked credential.

## Live recordings and fixtures

The default cassette mode is offline replay. `RECORD=1` sends requests to live
providers and writes their responses under `fixtures/`. Before committing a new
fixture, review it for credentials, personal information, private URLs, request
headers, provider metadata, and data that you do not have permission to
redistribute. Public permit records are still worth reviewing because the
fixtures can preserve names, addresses, and third-party response content.

Field requests are quota-bearing external writes. The CLI keeps them in
validation-only/dry-run mode by default; use `--live-field-request` only when
you have reviewed the payload and intend to spend a request unit. Keep the
deterministic idempotency key behavior intact when changing that path.

## Reporting a vulnerability

Please do not open a public issue with a secret or an exploitable proof of
concept. Use GitHub's private vulnerability reporting for the repository when
available, or contact the maintainer privately through GitHub. Include the
affected file or dependency, impact, reproduction steps that do not disclose
credentials, and a suggested mitigation if you have one.

This project is a demonstration repository and does not promise production
security support or uptime.
