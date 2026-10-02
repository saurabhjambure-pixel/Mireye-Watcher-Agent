# Contributing

Thanks for taking a look. Expansion Radar is intentionally a small,
opinionated demo, so focused changes are easier to review than broad
refactors.

## Local development

Requirements: Node.js 20 or newer.

```bash
npm install
npm run verify
npm run pipeline
```

The default pipeline replays checked-in cassettes and does not need API keys
or network access. Keep tests deterministic and add or update a fixture only
when the behavior it demonstrates is clear and the recorded response has been
reviewed for secrets and redistributability.

## Pull requests

- Explain the user or product problem the change solves.
- Keep deterministic gate and scoring logic separate from network and LLM
  calls.
- Preserve the cost ledger and make new paid or quota-bearing behavior
  explicit.
- Update the README or `.env.example` when setup or CLI behavior changes.
- Run `npm run verify` before opening the pull request.

Please do not include real API keys, unreviewed live recordings, or unrelated
generated output in a pull request. See [`SECURITY.md`](SECURITY.md) before
working with live mode.
