# Spec: Data Privacy Guards

_Status: documents existing behavior as of 2026-08-28. Traces to `docs/intent/omakei.md`._

## Objective

Keep the user's financial data on their machine and out of git. The intent's
constraint is "nothing leaves the machine"; the README promises "no account, no
cloud, and no telemetry." This spec covers the mechanical guards that back that
promise: what git is forbidden to track, what the pre-commit hook scans for, and
where the line sits between what a scanner can catch and what only review can.

**User:** Andrew and any contributor, committing to a repo that is developed
against real statements sitting in a gitignored folder. The guards have to make
the easy mistake — a real card number pasted into a fixture, a statement dump
staged by a wildcard `git add` — hard to commit by accident.

**Success:**

- Real statement files and `omakei-ledger.json` cannot be tracked; `npm test`
  fails if one ever is.
- A commit that stages a payment card number, SSN, routing number, IBAN, real
  email, personal phone number, or street address is refused, with the file and
  line named.
- A household-specific word listed privately is redacted, not printed, in the
  failure output — and the list itself is never committed.
- The scanners' own test file, full of published test vectors, is exempt without
  weakening the scan anywhere else.

## Tech Stack

Node standard library only (`node:child_process`, `node:fs`). The scanners run
in the pre-commit hook and in `npm test`. No dependencies.

## Commands

```
Audit everything tracked:  node scripts/check-no-personal-data.mjs
Audit this commit:         node scripts/check-no-personal-data.mjs --staged
Block statement files:     node scripts/check-no-statements.mjs
All of the above + tests:  npm test
Enable the hook:           git config core.hooksPath .githooks
```

`npm test` runs `check-no-statements.mjs` (every tracked file) and
`check-no-personal-data.mjs` with no flag (every tracked file). The pre-commit
hook runs `check-no-statements.mjs` and `check-no-personal-data.mjs --staged`
(what the commit adds).

## Project Structure

```
scripts/check-no-statements.mjs        → blocks whole files by name/path
scripts/check-no-personal-data.mjs     → scans content for recognisable-shape data
scripts/check-no-personal-data.test.mjs → the test vectors; the one whole-file scan exemption
.githooks/pre-commit                   → runs both, staged-only, on every commit
.githooks/personal-terms               → gitignored; one household word per line
.gitignore                             → statement extensions, ledger names, statement dirs, .dev/, personal-terms
```

## Behavior this spec fixes in place

### `check-no-statements.mjs` — files by name

Blocks any tracked path matching `\.(csv|tsv|ofx|qfx|ofc)$` or a path segment of
`Financial_Statements` / `statements` / `data/statements`, plus
`(folio|omakei)-ledger.json` (`folio-` is a retired early name, still blocked).
Consequence for the parser: statement fixtures are **inline strings** in
`parse.test.ts`, never files.

### `check-no-personal-data.mjs` — content by shape

Runs line by line. Each `RULES` entry is a regex plus an optional `accept`
predicate that uses nearby context:

| Rule | What makes it a hit, not a coincidence |
|---|---|
| payment card number | real issuer prefix **and** that issuer's length **and** Luhn **and** not all-same-digit (an OFX timestamp passes Luhn alone) |
| US SSN | `\d{3}-\d{2}-\d{4}` |
| bank routing number | ABA checksum **and** `routing\|aba\|rtn\|wire\|transit` within 64 chars |
| account number | `account\|acct\|a/c\|routing\|iban\|sort code` then digits within 20 chars |
| IBAN | a real ISO country prefix, not any base64 run |
| email address | not `@example.*`, `@test`, `@localhost`, `@invalid`, `noreply.*`, and not `you@`/`user@`/… |
| phone number | not a toll-free prefix (`800/833/844/855/866/877/888`) — merchant support lines are in the fixtures by design |
| street address | number + 1–3 capitalized words + a street-type suffix |

Plus, if `.githooks/personal-terms` exists, one synthesized rule matching any
listed word (case-insensitive, word-boundaried), reported as `[redacted]`.

### The pragma

A line carrying `omakei:allow-personal` (on it or the line above) is exempt — for
a merchant's public support number, not to silence a real hit. Mirrors how
eslint-disable comments work.

### The self-test exemption

`scripts/check-no-personal-data.test.mjs` is the **only** whole-file exemption.
It must contain the things the scanner looks for — the card networks' published
test numbers, the 555 fictional phone range, the IBAN from the standard's
examples. Everything else uses the per-line pragma.

### What the scanner cannot do

It cannot tell that a merchant, a balance, or a family name is *yours*. That
judgement lives in AGENTS.md and is enforced by review. A clean run is one guard
passing, not proof the diff is safe. For household-specific words, the private
`.githooks/personal-terms` list is the tool — gitignored precisely so the block
list is not itself the leak.

### No default ledger path

Nothing is attached until the user picks a folder. There is no sample/dummy
ledger anywhere in the tree (also a `dashboard-app` boundary).

## Testing Strategy

`check-no-personal-data.test.mjs` exercises `scanText` / `buildRules` directly:

- Each rule fires on a true positive (a published test vector) and stays silent
  on its near-miss (OFX timestamp vs card, toll-free vs personal phone, base64
  vs IBAN, `@example.com` vs real email).
- The pragma exempts its own line and the line below.
- `[redacted]` replaces a `personal-terms` match in output.

`check-no-statements.mjs` has no unit test; its behavior is observable — a
blocked file fails `npm test`.

New scanner rules need a true-positive and a near-miss case. Loosening a rule
needs the near-miss that motivated it.

## Boundaries

**Always:**
- Keep statement extensions, ledger filenames, and statement directories in
  `.gitignore`.
- Keep parser and scanner fixtures as invented values / published test vectors —
  national-chain merchants, `example.com`, card-network test numbers.
- Treat a clean scan as one check passing; review for "is this *mine*".

**Ask first:**
- Loosening any `accept` predicate (each one is load-bearing against a specific
  false positive).
- Adding a whole-file scan exemption (there is exactly one today).
- Removing a `.gitignore` entry for a statement type.

**Never:**
- Commit `.githooks/personal-terms`.
- Use `omakei:allow-personal` to hide a genuine hit.
- Put a household merchant, account number, balance, address, or family name in
  a test, fixture, comment, or default rule.
- Add telemetry, analytics, crash reporting, or any outbound request from the
  app (see also `dashboard-app.md` and `ledger-server.md`).

## Success Criteria

Verified against the current suite (2026-08-28).

1. **Met.** `check-no-personal-data.test.mjs` passes: every rule fires on its
   vector and is silent on its near-miss.
2. **Met.** `npm test` runs both scanners over every tracked file and the tree
   is clean.
3. **Met.** `.gitignore` blocks `*.csv/*.tsv/*.ofx/*.qfx/*.ofc`,
   `omakei-ledger.json`, `folio-ledger.json`, `statements/`, `.dev/`, and
   `.githooks/personal-terms`.
4. **Met.** The pre-commit hook runs `check-no-statements` and
   `check-no-personal-data --staged` before `check-dist-fresh`.
5. **Met.** `scanText` reports a `personal-terms` hit as `[redacted]`.

## Open Questions

1. **The hook is opt-in per clone.** `git config core.hooksPath .githooks` is a
   manual step; a clone that skips it commits with no guard. Same gap as
   `build-and-distribution.md` — a CI job running `npm test` on every push would
   backstop it (the no-flag scan already covers every tracked file).
2. **`--staged` scans added content, not the diff hunks.** A file already
   tracked with a latent hit that a commit *edits elsewhere* is re-scanned whole
   and will block that unrelated commit. Rare, but surprising.
3. **`MAX_BYTES` (5 MB) and the 8000-byte binary sniff** are unexplained
   constants. A minified vendor bundle just under 5 MB gets fully scanned on
   every `npm test`.
4. **No guard on outbound network calls.** "No telemetry" is enforced by review
   and the CSP-free nature of a local server, not by a check. A lint rule
   banning `fetch`/`XMLHttpRequest` to non-`/__omakei` targets in `src/` would
   make it mechanical.
5. **Street-address regex is US-format only.** A non-US contributor's address in
   a comment would pass. Acceptable given the user base, worth noting.
