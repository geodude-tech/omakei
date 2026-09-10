# Spec: Bar Widget

_Status: documents existing behavior as of 2026-09-09. "Where a capability belongs"
was forward when it was agreed; its first row — categorizing an unknown merchant
from the popup — is built. The set-aside row still is not, and waits on a CLI.
Traces to `docs/intent/omakei.md`._

## Objective

Show the standing gap between in and out — net after spend and set-asides, over
the month ending today — as a pill on the Omarchy bar, and open into a popup with
the month's spend, income, reserved, categories, and recent activity. Left-click
for the popup, right-click to open the editor, middle-click to reload.

The intent is explicit that **the widget is the hook, not the product**: it is why
Omarchy is the right beachhead (its users already have an agent on the machine),
and it "stops driving design decisions." This spec documents what the widget does
today and, more importantly, the constraints that keep it from hanging the bar.

**User:** an Omarchy user glancing at the bar. They never configured a ledger
path; the editor recorded the attached folder and the widget finds it.

**Success:**

- The pill shows `+$3k` / `−$1k` (compact, signed) for the month ending today, or
  `Omakei` when there is no ledger.
- The pill reads the same on the 3rd as on the 23rd. A calendar-month figure does
  not: the mortgage and child care land on the 1st and the pay that covers them
  arrives later, so it opens deeply negative every month and climbs back.
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
QML check:       npm test               # scripts/check-qml.mjs runs the QML offscreen,
                                        # then the panel for real if there is a display
```

`Model.js` is factored so the logic is testable in Node (`model.test.mjs` loads
it with `new Function`), and the `.qml` files are kept thin. The QML that is
left runs under `scripts/check-qml.mjs` in two tiers, both against a throwaway
ledger, and both skipping rather than failing where what they need is absent.

**Offscreen** (`qml-harness/scene.qml`): quickshell renders the "Needs a
category" section with no compositor and no window on anyone's screen. Skips
without quickshell or the omarchy shell.

**Against a real compositor** (`qml-harness/panel-scene.qml`): `Panel.qml`
cannot load offscreen at all — its `KeyboardPanel` is a `PanelWindow`, and with
no backend it fails before a single binding runs — so this tier creates the
panel for real and reads its properties back. That covers the bindings, and the
properties the bar widget reads off the panel by name, where a rename is a
silent runtime error rather than a load failure. It **never calls `open()`**:
creating the panel maps no surface and takes no keyboard grab, which is what
makes it safe to run on a working desktop. Skips without `WAYLAND_DISPLAY`.

What neither tier reaches is the bar itself — the pill, the popup's placement,
and no-hang-at-login are still verified by hand.

## Project Structure

```
manifest.json                    → plugin manifest: kind "bar-widget", entry BarWidget.qml, settings schema
BarWidget.qml                    → the pill: label, tooltip, click routing, lazy Panel loader
Panel.qml                        → the popup: month nav, the reader Process, the revision FileView, keys
NeedsCategory.qml                → the "Needs a category" section: the rows, the dropdowns, and the one write
Model.js                         → all logic: summarize(), openingMonth(), formatMoney(), editorUrl(), …
scripts/omakei-read-ledger.mjs   → prints {"path","ledger","uncategorized"} as JSON; the only disk read the widget makes
scripts/omakei-categorize.mjs    → the only write the widget can make, run as `<merchant> <category>`
scripts/omakei-open              → starts the editor server if nothing is serving, then opens the URL
```

Shell-loaded files at the repo root ship to installers via `omarchy plugin add`
(which clones the git tree). `check-plugin.mjs` validates `manifest.json`,
`BarWidget.qml`, `Panel.qml`, `NeedsCategory.qml`, `Model.js` on a clean staging
dir — a new shell-loaded file at the root belongs in that list.

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

### Categorizing a merchant from the popup

Under the stat line, "Needs a category" lists the merchants with no category
yet, biggest first, each with a dropdown of the fixed 20. Picking one runs
`omakei-categorize.mjs <merchant> <category>` — one value, one command — which
writes the rule, re-derives every transaction, and bumps the revision file, so
the row leaves on the read that follows.

Four things keep it inside the ceiling this spec sets:

- **The list is the reader's, not `Model.js`'s.** The merchant key comes from
  `extractMerchant`, and `src/lib/finance/uncategorized.ts` is the one
  implementation — shared with `--list` and with the editor's own list, so all
  three name the same merchant. A QML restatement of that heuristic would write
  rules that match nothing.
- **The list is whole-ledger and capped at six.** A rule is merchant-wide, so
  scoping it to the month on screen would hide the merchant the user is about to
  fix. The tail is `--list` in a terminal; the popup says how many it is not
  showing.
- **Writes are queued, one at a time, and a second pick for the same merchant
  is queued rather than dropped.** The CLI refuses a write against a ledger that
  moved under it, so two racing invocations would make one retry for nothing;
  the rule is keyed by pattern, so the last write wins, which is the category
  the dropdown is showing.
- **A refused write says so.** A non-zero exit leaves the row reading "could not
  save" instead of quietly reverting. A write that silently does nothing is the
  failure this ledger has already been bitten by once (`ledger-server.md`).
- **An open dropdown owns the keyboard.** `PanelKeyCatcher.blocked` follows
  `Dropdown.popupOpen`, or `j`/`k` would also step the month and Escape would
  close the whole popup.

### A plugin directory is not a QML import path

The shell loads a plugin by absolute path from `~/.config/omarchy/plugins/<id>/`,
which is outside its own config root, and quickshell serves it under a `qs:`
URL. There, **a sibling `.qml` file is not implicitly a type.** `NeedsCategory { }`
in `Panel.qml` fails to compile with "NeedsCategory is not a type", and a bare
`import "."` does not fix it. A namespaced directory import does:

```qml
import "." as Local
...
Local.NeedsCategory { }
```

This is invisible to `qmllint` and to `omarchy-plugin-validate`, and it breaks
the whole popup rather than one section. `check-qml.mjs` guards it. **A sixth
shell-loaded file needs the same namespace and the same entry in
`check-plugin.mjs`.**

### Popup interactions

| Input | Action |
|---|---|
| A category in "Needs a category" | Write that merchant's rule via `omakei-categorize.mjs` |
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

### The rolling window

`Model.rollingSummary` sums in and out over the month **ending today**, and
subtracts the set-asides in full — the window is one calendar month long, so a
monthly reserve belongs to it whole.

The window opens the day after the same date one month back: Sep 9 looks back to
Aug 10. That day is clamped to the earlier month's length first, so Mar 30 (no
Feb 30) clamps to Feb 28 and opens on Mar 1. Every day-of-month therefore falls
inside exactly once, and every monthly bill is counted once whichever day you
ask on.

It is not perfectly flat. Biweekly pay lands two or three times in a month-long
window depending on where you stand, so the number still moves by a paycheck.
That is a far smaller artifact than the calendar boundary it replaces.

Two fallbacks keep it honest, both to the calendar-month figure:

- **`complete` is false.** The ledger does not reach back to the start of the
  window. A freshly synced ledger holding only this month's statement would
  otherwise report a month of income against a week of spending.
- **The popup is browsing another month.** Past months are shown as themselves.
  Only the current month rolls, so `Panel.rollingHeadline` is false whenever
  `viewMonth` is not this month. The pill is unaffected — it always speaks for
  now, whatever the popup is showing (`Panel.barSummary`).

`Panel.today` advances on day rollover, not just month rollover, so a popup left
open overnight does not keep reporting yesterday's window.

### The pill label

`Model.barLabel` → `Omakei` when `!hasData`, else
`formatMoney(net, { sign: true, compact: true })` over `Panel.barSummary`. The
button goes `active` (urgent styling) when net is below `−0.005`. The hover text
(`Model.barTooltip`) names the window the number covers — a date range when it is
rolling, the month when it has fallen back — then spent, in, and reserved.

### The popup headline

The big number is the rolling one, with the date range under it and the
month-to-date figure under that, so the month header above it is not left
promising a number that is no longer there.

The spent and in figures follow the headline's window, so the big number
decomposes into the two beneath it. Month-scoping them would print `$0 in`
under a healthy headline for the first half of every month — true of the month,
and an invitation to read the headline as wrong. Reserved and the uncategorized
count stay month-scoped, as do the pace sparkline, the category bars, and recent
activity; they sit below the month-to-date line that introduces them.

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
| Categorize an unknown merchant | **Widget** — built | One value, one command; `omakei-categorize.mjs` already does it |
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
  `revisionFilePath`, `daysInMonth` (leap February, unparseable month),
  `dailySpend` (every day present, income and transfers and other months
  excluded, empty ledger safe).
- `model.test.mjs` also pins the write half: `parseReaderOutput` carrying the
  merchant rows, `categoryOptions` against `CATEGORIES` (the test imports the
  real list, because `Model.js` cannot), and `categorizeCommand` returning `[]`
  for every half-formed input rather than a command with a hole in it.
- `omakei-read-ledger.test.mjs` — the reader resolves the path from the state
  file or the override, always exits 0, always prints valid JSON, and returns
  the uncategorized merchants sorted and capped.
- `omakei-categorize.test.mjs` — `--list --json` prints what the popup consumes,
  and `--json` without `--list` is refused.
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
6. **Met.** (2026-09-09) The popup's "Needs a category" section is covered by
   `model.test.mjs`, `omakei-read-ledger.test.mjs`, `omakei-categorize.test.mjs`
   and `uncategorized.test.ts`, and the QML by `check-qml.mjs` — ten checks
   offscreen, including a real write by the real CLI against a throwaway
   ledger. Verified once by hand as well, on a nested headless compositor: the
   panel loads from an absolute path, the reader fills the section, picking a
   category writes the rule, and the row leaves on the re-read.

## Open Questions

**The write half is no longer blocked.** An open editor tab used to hold the
whole ledger in memory and reinstate it on its next save, so anything written
underneath — a rule from `omakei-categorize.mjs`, and prospectively anything the
widget wrote — disappeared silently. That is fixed: a save now says which
version of the ledger it was derived from and is refused if the file has moved
on, and the editor merges with whatever beat it there and retries. See
[ledger-server.md](ledger-server.md), "The ledger has more than one writer."

What this means for the widget is that invoking `omakei-categorize.mjs` from the
popup is safe with the editor open, which it was not before. The CLI keeps a
narrow window of its own (recorded in that spec's Open Questions) that a widget
write inherits; it is microseconds rather than minutes, and the CLI retries.

1. **No test proves the no-hang-at-login property.** It is the reason the reader
   exists, and it is only checked by hand. A test that points the reader at a
   FIFO and asserts it still exits 0 within a timeout would guard it.
2. **`currentSummary` recomputes `summarize` for the current month on every
   access when `viewMonth` is not the current month.** Cheap at 30k rows, but
   it is an unmemoized derived property read from bindings.
3. **The `appUrl` setting defaults to `http://127.0.0.1:8080/` in two places**
   (`manifest.json` and `Panel.qml`). If the server's default port ever changes,
   both move. Worth a single source.
4. **`Model.dailySpend` is a second implementation of
   `src/lib/finance/summaries.ts`'s `dailySpend`.** `Model.js` is ES5 loaded by
   the QML engine and cannot import TypeScript, so the widget cannot share the
   original — the same reason `Model.summarize` already restates `monthSummary`
   and `categoryTotals`. It is precedent, not an accident, but it is still two
   copies of one piece of arithmetic that can drift: the QML one adds
   `cumulative` and takes `(transactions, month)` to match `Model.summarize`,
   while the TypeScript one takes `(month, rows)`. Both are tested
   independently. If a third copy ever appears, generate them instead.
5. **A category popup can be clipped by the bottom of the panel window.**
   Measured on a nested compositor: the option list is 254px tall, and against a
   585px panel the last two rows overflowed by 1px and 40px. A Qt `Popup` lives
   in its window's overlay, so it is cut off rather than escaping. The harness
   ledger is small, which puts the section near the bottom; a real month has
   categories and activity below it. The fix would be opening upward near the
   edge, which belongs in the shared `Dropdown`, not here.
6. **The category dropdowns are mouse-only.** `PanelKeyCatcher` takes Tab for
   switching panels, so nothing in the popup — the dropdowns or the "Open
   Omakei" button — can be reached by keyboard; once a dropdown is open, keys
   work normally. The button has always had this, so it is not a regression, but
   the popup now has an input worth reaching. Fixing it means a cursor model
   over the rows, which is the shape the omarchy panels use.
7. **Middle-click to reload is undiscoverable.** It is in the README but there is
   no affordance. Given the revision-file watch, a manual reload is rarely
   needed — consider whether it earns its keep.
