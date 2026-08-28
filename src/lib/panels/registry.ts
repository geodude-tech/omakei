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
 */
import type { ComponentType } from "react";
import type { PanelMeta, PanelProps } from "@/lib/finance/types.ts";

export interface RegisteredPanel {
  /** Filename without extension. Stable, and the tiebreak for equal `order`. */
  id: string;
  title: string;
  span: 1 | 2 | 3 | 4 | 5;
  order: number;
  Component: ComponentType<PanelProps>;
}

type PanelModule = { default?: unknown; meta?: unknown };

const modules = import.meta.glob<PanelModule>("../../panels/*.tsx", { eager: true });

function isMeta(value: unknown): value is PanelMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as PanelMeta;
  if (typeof meta.title !== "string" || meta.title.trim() === "") return false;
  if (meta.span !== undefined && ![1, 2, 3, 4, 5].includes(meta.span)) return false;
  if (meta.order !== undefined && !Number.isFinite(meta.order)) return false;
  return true;
}

function read(path: string, mod: PanelModule): RegisteredPanel | null {
  const id = path.split("/").pop()!.replace(/\.tsx$/, "");
  if (typeof mod.default !== "function") {
    console.warn(`Panel "${id}" has no default-exported component; skipping.`);
    return null;
  }
  if (!isMeta(mod.meta)) {
    console.warn(`Panel "${id}" is missing a valid \`meta\` export; skipping.`);
    return null;
  }
  return {
    id,
    title: mod.meta.title,
    span: mod.meta.span ?? 2,
    order: mod.meta.order ?? 100,
    Component: mod.default as ComponentType<PanelProps>,
  };
}

/** Every valid panel, in render order. */
export const panels: RegisteredPanel[] = Object.entries(modules)
  .map(([path, mod]) => read(path, mod))
  .filter((p): p is RegisteredPanel => p !== null)
  .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
