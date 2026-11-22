# site-generator-speed-01-run-20261122 — NOTES

Entry: a faster drop-in for makefun-site 1.0.0 (make.fun's own static site
generator). Files: `solve.js` (the solver, dependency-free ES module,
`run(input)` returns makefun-site's output tree), `main.ts` (the harness
driver, unchanged from the house baseline: reads `/input/cases.json`,
answers each case with `run`, writes `/output/answers.json`),
`package.json` (`{"type": "module"}`), `README.md`, `LICENSE` (MIT),
`.makefun/owner.json` (payout wallet).

## Design

`run(input)` follows makefun-site's pipeline in its order — sources,
front matter and refusal checks, permalinks, Markdown, collections, tags,
layouts, report — reimplemented for speed, with the reference's rules
reproduced exactly (its README states them; its code is the reference
where the two differ). The optimisations:

- **Markdown inline** — the scan jumps from one markup character to the
  next with `indexOf` (C++ speed) instead of stepping character by
  character, and flushes the plain text between marks in one escaped run.
  A mark that turns out literal stays in the pending run. `findUnescaped`
  / `findSingleStar` are the reference's own scans, kept verbatim.
- **Block lexer** — a first-character dispatch: a line starting with a
  letter can only be a paragraph line, so most lines skip all seven
  opener regexes; only candidate lines run them. `trimLine` is a manual
  space/tab trim (the reference trims spaces and tabs only, not all
  whitespace). Blockquote `> ` is dropped with a slice, fence-close is
  only tested on backtick lines.
- **Front matter** — read without splitting the file: the closing `---`
  is found with `indexOf`, the front-matter lines are walked in place,
  and the body is a slice, never split and re-joined. Line numbers in
  refusal messages are identical to the reference's.
- **Slugs** — memoised per `run()` call; pure-ASCII inputs skip the NFKD
  normalisation (ASCII is fixed under NFKD and holds no combining
  marks). The slug loop is otherwise the reference's, code point for
  code point.
- **Reading time** — words counted with a char-code scan whose whitespace
  set is exactly JS `\s`, instead of building a `/\S+/g` match array.
- **Escaping** — one `/[&<>"']/g` pass that builds the result by slices
  instead of test-then-replace with a callback.
- **Templates** — rendered into an array joined once, with scopes as a
  chain of null-prototype objects, so a path's first name is one property
  lookup instead of a scope-chain walk with `hasOwn` at every step
  (a name bound to `undefined` in an inner scope still shadows, exactly
  as the reference's walk). Cards are built once per source and reused
  for the layout page and the lists.
- **Page-independent partials** — a template whose free names (its own
  paths plus its includes', with its own `for` bindings excluded) are
  only `site`, `tags` and `recent` reads nothing that varies from page to
  page, so its output is memoised per case at each include depth
  (typically `header`/`nav`). A card that reads its loop's `p` is never
  memoised. Nothing is cached from one `run()` call to the next: every
  memo, parsed template and slug cache is created fresh inside `run()`.

Two things were tried and **rejected** on measurement: compiling
templates to functions with `new Function` (median 181 ms/set vs 169 ms
for the tree-walking interpreter — the helper calls per node cost more
than the dispatch they replace), and counting words with
`String.match(/\S+/g)` (30 ms vs 20 ms for the char-code scan).

## Benchmarks (practice set, 3 cases, 1,091 files, this VM)

`run()` only, warmed, 8 interleaved runs of 5 sets each (Node 24 here;
the harness runs Node 22 — the code uses only ES2022 features):

| solver | median ms / 3-case set | range |
|---|---|---|
| makefun-site 1.0.0 (house baseline) | 502 | 493–518 |
| this entry | 138 | 132–164 |

Speedup on `run()`: **~3.6x**. End to end through `main.ts` (user CPU,
includes Node startup and the JSON parse/stringify both entries pay):
baseline 0.99–1.12 s, this entry 0.56–0.70 s.

## Verification

- **Practice set** — the kit's scorer on the entry's `main.ts` output:
  `passed: 1, cases_passed: 3, cases_total: 3`.
- **Differential fuzz** — 150 sites drawn with the kit's own generator
  (`program/generator/rng.ts` + `subject/sites.mjs`, seeds `fuzz-0` …
  `fuzz-149`, all three size bands), each compared as canonical JSON
  against the vendored makefun-site 1.0.0 `build()`: **0 mismatches**.
  One real bug was found this way and fixed: the split-free front-matter
  reader missed a closing `---` on line 1 (its preceding `\n` sits at
  index 3, before the old search start of 4) and wrongly reported "the
  front matter is not closed".
- **Hand-crafted edges** — 71 differential checks vs the reference, all
  passing: every template parse error, unclosed/mismatched
  for/if/else, self- and mutually-recursive includes (depth-8 cutoff),
  9-deep include chains, every front-matter refusal reason, posts with
  no date, reserved `tags/`/`page/` dirs, drafts, missing layouts, slug
  collisions incl. Unicode (café/Zürich/naïve, `!!!` → `untitled`,
  64-char cut), duplicate paths, CRLF files, empty/unterminated files,
  link resolution (`../` above root, fragments, static files, missing
  targets, schemes), unclosed fences/code spans/strong/em, lists with
  continuations and non-1 starts, no-post sites, pagination.
- **Determinism** — `run()` reads no clock, environment, randomness or
  file; the same input gives the same output tree.

## Parent steps (repo creation + bundle + check + submit — NOT done here)

1. Create the GitHub repo **zalana28/site-generator-speed-01-run-20261122**
   (public, created after the bounty opened 2026-11-22T20:00:00Z).
2. Push exactly these files to its default branch: `solve.js`, `main.ts`,
   `package.json`, `README.md`, `LICENSE`, `NOTES.md`,
   `.makefun/owner.json` (total ~42 KB, far under the 4 MiB limit).
3. Check with the kit CLI before submitting, e.g. from the kit dir:
   `node cli/makefun.mjs grade-local` (or the bundle/check command the
   parent uses for program/v1 entries) against the practice set; expect
   `passed: 1, cases_passed: 3`.
4. Submit with the make.fun CLI using account `@lively-heron-10` and the
   repo above (entry signing is a message signature; no fee, no funds
   move). Deadline **2026-11-24T20:00:00Z** (03:00 WIB 25 Nov). Bounty:
   https://make.fun/bounty/site-generator-speed-01-run-20261122 — $100
   pot, $10 each for 1st–10th place, only for entries beating the house
   baseline at 95% confidence.
