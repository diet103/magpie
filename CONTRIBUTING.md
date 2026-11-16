# Contributing

Magpie is a small project built for one household and shared in case it is useful to yours. Bug reports
are welcome. For anything bigger than a fix, open an issue first so we can agree on it before you spend an
evening.

## Getting it running

Needs Node 26.13 or newer. There is no build step.

```sh
npm ci
cp .env.example .env    # then set BOOTSTRAP_EMPTY_DB=1 for the first start
npm run dev
npm run check           # type check plus every test; run it before you push
```

`CLAUDE.md` describes the layout and the conventions that matter (it is written for Claude Code, and reads
fine for people). `test/README.md` describes the tests.

## What a change needs

- A bug fix comes with a test that fails without it.
- Every write goes through a function in `src/domain/` so it shows in Activity and can be undone.
- Text a person reads is plain and short.
- A database change is a new numbered file in `src/db/migrations/tracker/`; never edit one that has shipped.
- No new runtime dependency without a good reason. There are seven.

## Security problems

Please do not open a public issue. See `SECURITY.md`.
