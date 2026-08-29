# Specs

Each spec captures one capability of Omakei: what it does, the rules it holds to,
and where it is guarded. All trace to `docs/intent/omakei.md`, which takes
precedence over any spec.

The first two were written before the code and are marked _implemented_. Most of
the rest were written after, to capture existing behavior against the intent; they
are marked _documents existing behavior_ and each carries an **Open Questions**
section listing behavior that looks wrong or underspecified — none of it acted on
yet. One — [categorization.md](categorization.md) — started as a _forward spec_
(target behavior, then built): engine tests, the load-time re-derive, and the
`omakei-categorize.mjs` write path landed against it.

| Capability | Spec | Depends on | Reads for the loop |
|---|---|---|---|
| Reading the ledger from outside the app | [ledger-contract.md](ledger-contract.md) | — | front half — see also `docs/ledger.md` |
| Adding a dashboard panel | [panel-contract.md](panel-contract.md) | dashboard-app | back half — see also `src/panels/README.md` |
| Folder of exports → deduped, categorized ledger | [statement-import.md](statement-import.md) | — | |
| What category a bank line comes out as | [categorization.md](categorization.md) | — | front half — see also `docs/ledger.md` |
| The one process that touches disk | [ledger-server.md](ledger-server.md) | — | |
| The Omarchy bar pill and popup | [bar-widget.md](bar-widget.md) | ledger-server | |
| The editor SPA | [dashboard-app.md](dashboard-app.md) | ledger-server, statement-import | |
| Committed `dist/`, the build-hash hook, plugin shape | [build-and-distribution.md](build-and-distribution.md) | — | |
| Keeping financial data on the machine and out of git | [data-privacy-guards.md](data-privacy-guards.md) | — | |

Build order (for reference; everything already exists): statement-import,
ledger-server, data-privacy-guards, build-and-distribution are independent;
dashboard-app and bar-widget sit on ledger-server; panel-contract sits on
dashboard-app.
