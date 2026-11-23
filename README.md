# fast-makefun-site

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ibad-diary/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ibad-diary/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: it builds the same static site, byte for byte — the same front matter, template dialect, Markdown subset, slug rule and build report — in a fraction of the CPU time.

How it gets faster: templates are compiled once per build into plain JavaScript functions (scopes as prototype-chained objects, values read by direct property access) instead of walking a node tree through a scope chain on every render; Markdown is rendered in a single pass over its lines with no token objects, and inline markup is scanned with one regex for the next special character, copying plain runs in bulk through a single escape pass instead of escaping one character at a time; page cards are built once and reused; slugs use native regexes.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json` outside a container), answers each one with `run()` from `solve.js`, and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR/answers.json`). No dependencies, no network, no file reads at run time — just Node 22.

---

<sub>Entered on [make.fun](https://make.fun/?ref=s67gjd7a&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
