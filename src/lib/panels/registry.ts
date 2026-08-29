/**
 * Panel discovery.
 *
 * Panels are found, not registered: every `src/panels/*.tsx` is picked up by the
 * glob below. That is the whole point of the contract — adding a panel touches
 * one new file and no existing one, so an agent writing a panel has no shared
 * list to append to and nothing to merge.
 *
 * A module that does not match the contract is dropped here with a console
 * warning rather than crashing the dashboard. `scripts/check-panels.mjs` catches
 * the same mistake at `npm test` time, which is where it should be noticed.
 * The validation itself lives in `./validate.ts` and is unit-tested by
 * `src/lib/finance/panels.test.ts`.
 */
import { readPanel } from "./validate.ts";
import type { PanelModule, RegisteredPanel } from "./validate.ts";

export type { RegisteredPanel } from "./validate.ts";

const modules = import.meta.glob<PanelModule>("../../panels/*.tsx", { eager: true });

/** `../../panels/daily-spend.tsx` -> `daily-spend`, the panel's stable id. */
const panelId = (path: string) => path.split("/").pop()!.replace(/\.tsx$/, "");

/** Every valid panel, in render order. */
export const panels: RegisteredPanel[] = Object.entries(modules)
  .map(([path, mod]) => readPanel(panelId(path), mod))
  .filter((p): p is RegisteredPanel => p !== null)
  .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
