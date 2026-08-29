# Omakei

This month’s leftover on the [Omarchy](https://omarchy.org/) bar: spend, income, and what you set aside.

You start with a folder of bank, credit, or mortgage exports. Omakei builds the ledger in that folder. Nothing is uploaded. The files never leave this computer.

The pill is the part you see every day. The ledger underneath it is a plain file you can ask questions of — see [Asking your own questions](#asking-your-own-questions).

## Install

```sh
omarchy plugin add https://github.com/geodude-tech/omakei.git --enable
```

Review the QML before you enable it. Like every Omarchy shell plugin, it runs unsandboxed — with your user permissions, on this machine only. Omakei does not send your statements or ledger anywhere.

Nothing else to install: the editor ships prebuilt, and needs only Node, which Omarchy already has.

Update later with `omarchy plugin update omakei`.

## First run

You do not need a ledger yet.

1. Click the **Omakei** pill on the bar (or **Open Omakei** in the popup). The editor starts the first time you open it, which takes about a second; nothing runs in the background while Omakei is closed.
2. Choose the folder that holds your statements — any folder you already use, or an empty one you will drop exports into.
3. Omakei reads the files, auto-categorizes what it knows, and writes `omakei-ledger.json` into that same folder.
4. The pill shows this month’s net. It updates whenever the ledger file changes.

There is nothing to configure. Omakei records which folder you attached, and the widget reads the ledger from there on its own.

### Statement files

Use whatever your bank already gives you.

- **Preferred:** OFX or QFX
- **Also fine:** CSV (the usual download), TSV, OFC, or a `.txt` export

Subfolders are fine, and a folder named `Credit`, `Mortgage`, `Checking`, or `Savings` tells Omakei what kind of account its files came from. Drop in new months whenever you have them; Omakei picks them up the next time you open it.

### Categories

Known merchants are categorized automatically. A transaction with an unknown category only needs to be categorized **once** — Omakei remembers the merchant and applies it on the next import.

## On the bar

- Left click: spend, income, reserved, categories, and recent activity — this month, or the most recent month with activity if this month is still empty
- Right click: open Omakei
- Middle click: reload the ledger

In the popup: `[` / `]` change month, `t` jumps to this month, `o` opens Omakei, Escape closes.

## Asking your own questions

Omakei has no AI in it, and never will. What it has is one clean file.

Every statement you drop in the folder ends up in `omakei-ledger.json` next to them: one flat list of transactions with dates, amounts, descriptions, accounts, and categories. Point an agent that can read local files — Claude Code, or any harness you already use — at that file and ask the things a spending app never answers well:

- Am I spending more than I make, over the last six months rather than this one?
- Which categories are drifting up, and since when?
- What did I spend on restaurants this month compared to my average?

That is the whole idea. The dashboard shows the answers you got tired of asking for.

Before the first question, give the agent [`docs/ledger.md`](docs/ledger.md). It says where the file is and the handful of rules that make a total come out right — chief among them that transfers between your own accounts are not spending. Skip it and a credit-card payment gets counted as money spent, which quietly inflates every figure that matters.

### Pinning an answer

Each card on the dashboard is one file in `src/panels/`. If an answer is worth seeing every day, an agent can write a panel for it: a small component that reads the ledger and renders a number, a chart, or a single sentence. A panel that has nothing to say renders nothing, so a card only appears in the months it matters.

This needs a clone of the repository rather than a plugin install, because panels are compiled into the bundle. See [`src/panels/README.md`](src/panels/README.md) for the contract, and `npm run build` after adding one.

## Your data

Statements and the generated ledger stay in the folder you attached. Removing the plugin does not delete that folder. There is no account, no cloud, and no telemetry.

The editor listens on `127.0.0.1` only, and refuses requests that arrive under another host name or from another origin, so nothing else on your network — or in your browser — can reach your ledger.

### Keeping the ledger somewhere else

If you want the widget to read a ledger the editor did not write, set **Ledger file** in the widget settings to its path. That overrides the folder Omakei recorded. Leave it empty otherwise.

## Remove

```sh
omarchy plugin remove omakei
```

If the editor is still running, close it with `pkill -f omakei-serve`.

## Building it yourself

`dist/` is committed so installing needs no build step. To rebuild after changing
anything under `src/`:

```sh
npm install
npm run build         # writes dist/
npm run dev           # or work against the dev server on 127.0.0.1:8080
npm run dev:isolated  # dev server against a throwaway folder, not your ledger
```

`npm run dev` reads the folder you attached — your real statements. `npm run
dev:isolated` keeps its own state file and statements under `.dev/`, which is
gitignored, so development never reads or rewrites the real ones.

## License

MIT. See [LICENSE](LICENSE).
