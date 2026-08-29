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
 * `src/lib/finance/panels.test.ts` unit-tests the validation itself, below.
 */
import { readPanel } from "./validate.ts";
import type { PanelModule, RegisteredPanel } from "./validate.ts";

export type { RegisteredPanel } from "./validate.ts";

const modules = import.meta.glob<PanelModule>("../../panels/*.tsx", { eager: true });

/** Every valid panel, in render order. */
export const panels: RegisteredPanel[] = Object.entries(modules)
  .map(([path, mod]) => readPanel(path.split("/").pop()!.replace(/\.tsx$/, ""), mod))
  .filter((p): p is RegisteredPanel => p !== null)
  .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
