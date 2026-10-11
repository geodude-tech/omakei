---
name: omakei
description: Answer money questions from an Omakei ledger and change it safely. Use when asked about spending, income, net, subscriptions, bills, or recurring charges, or to import statements or categorize transactions with Omakei.
---

# Omakei

Run every command from the plugin directory: `~/.config/omarchy/plugins/omakei` on an install, or the repository root in a clone. Read [the ledger contract](../../docs/ledger.md) before the first query.

## Ground rules and personal rules

The rules in this file are the same for everyone and ship with the repository. Personal rules are one person's decisions about their own money, and they live only in that person's ledger:

- Category rules and pins. Write them with `scripts/omakei-categorize.mjs`.
- "Not recurring" marks and dismissed flags. The person sets them in the editor's Recurring card. No script writes them.

Never put a personal rule in `DEFAULT_PATTERNS`, a doc, a test, or your own memory. Read it from the ledger each time.

## 1. Answer from the ledger

Use the narrowest command that answers the question, and report the totals it prints. Do not add up rows yourself.

| Question                                         | Command                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| Where the ledger is, its size, its accounts      | `node scripts/omakei.mjs info`                                   |
| A month's income, spend, net, and top categories | `node scripts/omakei.mjs summary --month 2026-08`                |
| Transactions that match a filter, with totals    | `node scripts/omakei.mjs tx --from 2026-06-01 --category dining` |
| Recurring charges                                | `node scripts/omakei-subscriptions.mjs --json`                   |
| Merchants with no category                       | `node scripts/omakei-categorize.mjs --list --json`               |
| Statements already imported                      | `node scripts/omakei-import.mjs --status`                        |

None of these commands changes the ledger. If none answers the question, query the `spend` and `income` views with `sqlite3 -readonly` and follow [the five rules](../../docs/ledger.md#the-five-rules). If no folder is attached, say so. Do not search the disk for a ledger.

## 2. Keep the ledger on the user's machine

By default the ledger and the statements stay on the user's machine, and you run the commands there. Whatever you read goes to your own service, so read the summary or the rows the question needs, not the whole ledger.

[Grok-hosted mode](../../docs/intent/omakei.md#optional-grok-hosted-mode) is opt-in. Before the user turns it on or adds a bank connection, tell them what leaves their machine, using the list in that section.

## 3. Keep ledger data out of everything else

- Never copy ledger data into this repository, a commit message, a PR, an issue, a test, or a fixture. That covers merchant names, amounts, account names and digits, lenders, payees, towns, and people. Use invented names such as `ZORP WIDGETS`.
- Never move a ledger, a statement, or ledger output to another machine, your own server included, even as scratch. The one exception is a ledger the user chose to keep in Grok-hosted mode.
- Test a change with invented data. To check it against a real ledger, run read-only on the user's machine and bring back only pass or fail and counts.
- Save ledger output only in `WORK=$(mktemp -d)`, which is mode 0700, and run `rm -rf "$WORK"` when you finish.

## 4. Write deliberately

Every write goes through a script, never through SQL. Ask before each write and name the exact command, so the approval covers that command and nothing more.

- Back up the ledger first, with the `.backup` command in the runbook's [preflight](../../docs/runbooks/categorize-with-an-agent.md#0-preflight).
- To categorize, follow [the categorize runbook](../../docs/runbooks/categorize-with-an-agent.md). You propose, the person decides, you run `--dry-run` on each rule, and spend per month must not change.
- To import, run `node scripts/omakei-import.mjs`, then run it again. The second run must print `Nothing new.`, or `"added":0` with `--json`.

## 5. Name recurring charges the way the finder does

`scripts/omakei-subscriptions.mjs` sorts recurring charges by the category they are filed under. Recurring is all three groups. Report each group's subtotal from `totals` and the overall `total` in the JSON.

| Word          | Means                                    | Categories                                                                                                  |
| ------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Subscriptions | wants                                    | `subscriptions`                                                                                             |
| Bills         | needs                                    | `housing`, `utilities`, `insurance`, `debt`, `childcare`, `fees`, and every payment from a mortgage account |
| Other         | recurring, but its category says neither | any other category, or none                                                                                 |

## 6. Treat a missing recurring charge as a bug

The finder must show every charge tagged `subscriptions` and every mortgage account with a payment in the last 13 months. A charge the user marked "not recurring" moves to `hidden` in the JSON. See [the finder spec](../../docs/spec/subscriptions.md).

If a recurring charge the user knows about is missing, do not add it to the answer by hand. Report it as a bug, reproduce it with invented transactions in `src/lib/finance/subscriptions.test.ts`, and fix `src/lib/finance/subscriptions.ts`.
