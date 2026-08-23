# Omakei

This month’s leftover on the [Omarchy](https://omarchy.org/) bar: spend, income, and what you set aside.

You start with a folder of bank, credit, or mortgage exports. Omakei builds the ledger in that folder. Nothing is uploaded. The files never leave this computer.

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
2. Choose the folder that holds your transaction statements — any folder you already use, or an empty one you will drop exports into.
3. Omakei reads the files, auto-categorizes what it knows, and writes `omakei-ledger.json` into that same folder.
4. The pill shows this month’s net. It updates when the ledger file changes.

If the pill still says **Omakei**, set **Ledger file** in the widget settings to the `omakei-ledger.json` in the folder you attached.

### Statement files

Use whatever your bank already gives you.

- **Preferred:** OFX or QFX
- **Also fine:** CSV (the usual download), TSV, OFC, or a `.txt` export

Subfolders are fine. Drop in new months whenever you have them and open Omakei again to sync.

### Categories

Known merchants are categorized automatically. A transaction with an unknown category only needs to be categorized **once** — Omakei remembers the merchant and applies it on the next import.

## On the bar

- Left click: this month (spend, income, reserved, categories, recent activity)
- Right click: open Omakei
- Middle click: reload the ledger

In the popup: `[` / `]` change month, `t` jumps to this month, `o` opens Omakei, Escape closes.

## Your data

Statements and the generated ledger stay in the folder you attached. Removing the plugin does not delete that folder. There is no account, no cloud, and no telemetry.

The editor listens on `127.0.0.1` only, so nothing else on your network can reach it.

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
npm run build     # writes dist/
npm run dev       # or work against the dev server on 127.0.0.1:8080
```

## License

MIT. See [LICENSE](LICENSE).
