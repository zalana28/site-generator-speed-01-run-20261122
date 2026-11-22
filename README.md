# site-generator-speed-01-run-20261122 — faster drop-in for makefun-site 1.0.0

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/zalana28/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/zalana28/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in replacement for make.fun's own makefun-site 1.0.0, for the
bounty "Build a static site faster, 22 November 2026"
(`site-generator-speed-01-run-20261122`).

- `solve.js` — dependency-free ES module; `run(input)` returns
  makefun-site 1.0.0's answer — the output tree, path by path, byte for
  byte — for every case input `{ site, templates, files }`.
- `main.ts` — the harness program (unchanged from the house baseline):
  reads every case from `/input/cases.json`, answers each with `run`,
  writes `/output/answers.json`.

Approach: the same build pipeline as makefun-site, reimplemented for
speed — bulk inline-Markdown scanning with `indexOf` jumps, a first-character
dispatch in the block lexer, a split-free front-matter reader, memoised
slugs, a char-code word count, and template rendering over null-prototype
scope chains with page-independent partials (header/nav) memoised per case.
Nothing is cached from one case to the next. See `NOTES.md` for the design,
benchmarks (~3.6x faster than makefun-site 1.0.0 on the practice set's
`run()`) and verification.

License: MIT.
