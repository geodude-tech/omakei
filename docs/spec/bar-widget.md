# Spec: Bar Widget

_Status: documents existing behavior as of 2026-08-28. "Where a capability belongs"
and the write half of **Boundaries** are forward — agreed 2026-09-08, not yet built.
Traces to `docs/intent/omakei.md`._

## Objective

Show this month's leftover — net after spend and set-asides — as a pill on the
Omarchy bar, and open into a popup with the month's spend, income, reserved,
categories, and recent activity. Left-click for the popup, right-click to open the
editor, middle-click to reload.

The intent is explicit that **the widget is the hook, not the product**: it is why
Omarchy is the right beachhead (its users already have an agent on the machine),
and it "stops driving design decisions." This spec documents what the widget does
today and, more importantly, the constraints that keep it from hanging the bar.

**User:** an Omarchy user glancing at the bar. They never configured a ledger
path; the editor recorded the attached folder and the widget finds it.

**Success:**

- The pill shows `+$3k` / `−$1k` (compact, signed) for the current month, or
  `Omakei` when there is no ledger.
- Nothing runs while Omakei is closed. Opening the popup is the first read.
- The popup opens on a month that has data, even right after a sync that only
  brought in last month's closed statement.
- Saving in the editor updates the pill within a change-notification, with no
  polling and no unbounded file pulled into the shell.
- A huge ledger, a FIFO in the folder, or a stalled mount cannot block the bar at
  login.

## Tech Stack

QML (Quickshell), plus `Model.js` — **QML-compatible ES5**: `var`, no modules, no
arrow functions, no modern syntax the QML JS engine rejects. `Model.js` is linted
under its own ESLint block. The ledger read is a Node subprocess
(`scripts/omakei-read-ledger.mjs`), sharing `readCapped` with the server.

## Commands

```
Test:            npm test               # scripts/model.test.mjs, scripts/omakei-read-ledger.test.mjs
Lint:            npm run lint           # Model.js under its ES5 block
Plugin check:    npm test               # scripts/check-plugin.mjs runs omarchy-plugin-validate
```

There is no automated QML test. `Model.js` is factored so the logic is testable
in Node (`model.test.mjs` loads it with `new Function`), and the `.qml` files are
kept thin.

## Project Structure

```
manifest.json                    → plugin manifest: kind "bar-widget", entry BarWidget.qml, settings schema
BarWidget.qml                    → the pill: label, tooltip, click routing, lazy Panel loader
Panel.qml                        → the popup: month nav, the reader Process, the revision FileView, keys
Model.js                         → all logic: summarize(), openingMonth(), formatMoney(), editorUrl(), …
scripts/omakei-read-ledger.mjs   → prints {"path","ledger"} as JSON; the only disk read the widget makes
scripts/omakei-open              → starts the editor server if nothing is serving, then opens the URL
```

Shell-loaded files at the repo root ship to installers via `omarchy plugin add`
(which clones the git tree). `check-plugin.mjs` validates `manifest.json`,
`BarWidget.qml`, `Panel.qml`, `Model.js` on a clean staging dir.

## Code Style

`Model.js` is ES5 and side-effect-free:

```js
function openingMonth(ledger, today) {
  var now = currentMonth(today)
  var transactions = ledger && ledger.transactions
  if (!Array.isArray(transactions) || transactions.length === 0) return now
  if (monthHasTransactions(transactions, now)) return now         // this month, if it has data
  var selected = ledger && ledger.selectedMonth
  if (selected && monthHasTransactions(transactions, selected)) return selected  // else last-open
  return latestMonth(transactions) || now                         // else newest with activity
}
```

Conventions:

- **Logic lives in `Model.js`, drawing lives in `.qml`.** If a behavior can be
  unit-tested, it belongs in `Model.js` with a `model.test.mjs` case.
- **The reader is trusted to emit JSON and nothing else**, but `parseReaderOutput`
  still has to land somewhere sane on a half-written pipe — never throw inside a
  signal handler.
- **A failed read keeps what is on screen.** `ingest` returns early without
  blanking `root.ledger` when `out.ledger` is null.
- Match existing QML patterns; the popup styling mirrors the editor's cards.

## Behavior this spec fixes in place

### The widget never reads the ledger with a `FileView`

`FileView` cannot refuse a symlink, check for a regular file, or stop at a size,
and it reads synchronously while the bar starts — so a large ledger, a FIFO, or a
stalled mount hung the whole bar at login. The panel runs
`scripts/omakei-read-ledger.mjs` in a `Process` instead, asynchronously, and
parses its stdout. The reader uses the same bounded `readCapped` as the server.
**If the widget needs something else off disk, extend the reader — do not add a
`FileView`.**

### The one file it watches, it never reads

`ledger-revision` (in `$XDG_STATE_HOME/omakei/`, resolved by
`Model.revisionFilePath`) is watched with `preload: false`; `text()` and
`reload()` are never called. A watch costs a change notification and nothing
else. The server rewrites that file on every ledger change and every
attach/detach, so `onFileChanged → root.refresh()` re-runs the reader.

### Nothing runs while Omakei is closed

The `Process` has `running: true` at load for the first paint, but there is no
timer and no background poll. `refresh()` re-runs the reader only on: the
revision file changing, the configured-path setting changing, a middle-click, or
the popup opening without a ledger yet. `refresh()` also no-ops if a read is
already in flight.

### `followLedgerMonth`

`true` by default: a synced ledger sets `viewMonth` via `openingMonth`. Stepping
with `‹`/`›` or `[`/`]` sets it `false` so a background sync cannot yank the view.
`t` sets it back to `true` and jumps to the current month. `SystemClock` at
minute precision rolls `viewMonth` forward at midnight only when still following.

### Popup interactions

| Input | Action |
|---|---|
| Left-click pill | Toggle the popup |
| Right-click pill | Open the editor (`openOmakei`) |
| Middle-click pill | `refresh()` — re-read the ledger |
| `[` / `]` in popup | Previous / next month |
| `t` | This month (re-enable follow) |
| `o` / Return | Open the editor |
| Escape | Close |

### Opening the editor

Always routes through `scripts/omakei-open` (via `Model.openEditorCommand`),
which starts the server when nothing is serving — `omarchy launch browser`
cannot. The URL carries `?m=YYYY-MM` for the month the popup was showing; the
editor reads it once and strips it (`opening-month.ts`). Without a plugin
directory, `openEditorCommand` returns `""` rather than a command that opens a
dead page.

### The pill label

`Model.barLabel` → `Omakei` when `!hasData`, else
`formatMoney(net, { sign: true, compact: true })`. The button goes `active`
(urgent styling) when net is below `−0.005`.

## Where a capability belongs

### The widget is a front-end to a CLI

This is the Omarchy convention, not a rule invented here. Every first-party
panel in `omarchy-shell` mutates something, and not one of them implements the
mutation. `plugins/panels/monitor` shells out to `omarchy-brightness-display`,
`omarchy-hyprland-monitor-scaling`, and `omarchy-display-text-size`, then re-reads
through `omarchy-monitor-state`. Network, bluetooth, tailscale, audio, and power
have the same shape, and they take real input on the way — `TextField`,
dropdowns, a passphrase field with `echoMode`.

So the house rule is not "a panel does not write." It is:

> **A panel is a front-end to a CLI. One value, one command. Never a session.**

Brightness percent, scale factor, text size, one passphrase. That is the ceiling,
and it is the ceiling here too. Omakei already has both halves —
`omakei-read-ledger.mjs` is the read, `omakei-categorize.mjs` is the write — the
widget simply does not call the second one yet.

The point of routing through a CLI is not tidiness. A command that works
standalone from a terminal is testable in Node, usable by an agent, and reviewable
on its own; a write inlined into QML is none of those, and it runs inside the
shell process where a mistake takes the bar down with it.

### The three-way split

- **The agent** answers what only computation can answer — drift, six-month
  trends, "which categories are creeping up." This is the intent's whole thesis:
  one clean file, and a harness already on the machine. Analysis is not the
  widget's job, and mostly not the editor's either.
- **The editor** does what needs a session — attaching a folder, importing a
  month of statements, reviewing what deduped.
- **The widget** does what only *the person* can answer — the number at a glance,
  and the one ambiguity a machine cannot resolve: what is `SQ *PORCH SUPPLY`?

That last line is the case for categorizing in the popup. It is not convenience.
It is the only interaction where the user is the required input.

### What that costs

The test is one value, one command: can it be finished in a single gesture, by
someone glancing at the bar?

| Capability | Home | Why |
|---|---|---|
| Categorize an unknown merchant | **Widget** | One value, one command; `omakei-categorize.mjs` already does it |
| Add a reserved / set-aside | **Widget**, one at a time | Two fields — the passphrase pattern. Needs an `omakei-set-aside` CLI first; there is none |
| Attach a folder | Editor | Browsing a filesystem is a session |
| Import statements | Editor | Many files, dedupe, warnings to review |
| The rules table | Terminal | `omakei-categorize.mjs --list` / `--remove` already cover it. A table is not a panel |
| Charts, drift, dashboard panels | Editor / agent | Reading depth, not glancing |
| The full activity list | Editor | The popup's eight-row cap is the right call |

## Testing Strategy

- `model.test.mjs` — `openingMonth` (all four fallbacks), `summarize`,
  `latestMonth`, `editorUrl`/`editorQuery`, `openEditorCommand` (trailing slash,
  no plugin dir), `parseReaderOutput` (half-written pipe, wrong version),
  `revisionFilePath`.
- `omakei-read-ledger.test.mjs` — the reader resolves the path from the state
  file or the override, always exits 0, always prints valid JSON.
- `check-plugin.mjs` — `omarchy-plugin-validate` on the shell files (skipped when
  the validator is not on `PATH`).
- QML behavior (no hang at login, live refresh on save) is verified by hand.

## Boundaries

**Always:**
- Read the ledger only through `scripts/omakei-read-ledger.mjs`, asynchronously.
- Watch `ledger-revision` with `preload: false` and never read it.
- Keep `Model.js` ES5 and testable; keep the `.qml` files thin.
- Change anything on disk only by running a CLI that already works standalone
  from a terminal, `Process`-detached, and then re-reading. If the capability has
  no CLI, the CLI is the first half of the work.
- Keep daily viewing in the popup — do not rebuild attach, import, the rules
  table, or the full activity table there (docs/agents.md).

**Ask first:**
- Adding anything the widget reads off disk (extend the reader, and say why).
- Adding a write the widget can trigger — name the CLI it runs, and check it
  against "one value, one command."
- Adding a manifest setting.
- A timer or any periodic work.

**Never:**
- Add a `FileView` onto the ledger or the state file.
- Write to the ledger from inside QML — no file writing, no HTTP to the server.
  The widget invokes; the CLI writes.
- Put a session in the popup: multi-step flows, a table to edit, anything the
  user would sit down for.
- Put personal data in `Model.js` fixtures or defaults.
- Make the widget the design driver — it is the hook.

## Success Criteria

Verified against the current suite (2026-08-28).

1. **Met.** `model.test.mjs` and `omakei-read-ledger.test.mjs` pass.
2. **Met.** `openingMonth` returns this month when it has data, else the
   last-open month, else the newest month with activity, else this month
   (four `model.test.mjs` cases).
3. **Met.** `Panel.qml` reads via `Process` + `StdioCollector`, watches
   `ledger-revision` with `preload: false`, and has no timer.
4. **Met.** `parseReaderOutput("{trunca")` returns `{ path: "", ledger: null }`
   rather than throwing.
5. **Met.** `openEditorCommand` returns `""` with no plugin directory.

## Open Questions

**Blocking the write half.** An open editor tab holds the whole ledger in memory
and writes all of it on its next save, so anything the widget writes while a tab
is open is silently overwritten — `omakei-categorize.mjs` already carries the
warning ("Run this with the editor closed"), and a widget write inherits it. The
only write path is whole-file: `PUT /__omakei/ledger` in the server,
`writeAtomic` in the CLI. Categorizing from the popup must not ship before this
is settled — either the CLI routes through the running server when one is up, or
the editor stops holding the ledger. Nothing else in this section blocks anything.

1. **No test proves the no-hang-at-login property.** It is the reason the reader
   exists, and it is only checked by hand. A test that points the reader at a
   FIFO and asserts it still exits 0 within a timeout would guard it.
2. **`currentSummary` recomputes `summarize` for the current month on every
   access when `viewMonth` is not the current month.** Cheap at 30k rows, but
   it is an unmemoized derived property read from bindings.
3. **The `appUrl` setting defaults to `http://127.0.0.1:8080/` in two places**
   (`manifest.json` and `Panel.qml`). If the server's default port ever changes,
   both move. Worth a single source.
4. **Middle-click to reload is undiscoverable.** It is in the README but there is
   no affordance. Given the revision-file watch, a manual reload is rarely
   needed — consider whether it earns its keep.
