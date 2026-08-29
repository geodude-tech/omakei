/**
 * Pure validation for a discovered panel module, split out of `registry.ts` so
 * it can be exercised directly by `node --test`. `registry.ts` itself loads
 * panels through `import.meta.glob`, a Vite-only construct the plain test
 * runner cannot execute — this module has no such dependency.
 */
import type { ComponentType } from "react";
import type { PanelMeta, PanelProps } from "../finance/types.ts";

export interface RegisteredPanel {
  /** Filename without extension. Stable, and the tiebreak for equal `order`. */
  id: string;
  title: string;
  span: 1 | 2 | 3 | 4 | 5;
  order: number;
  Component: ComponentType<PanelProps>;
}

export type PanelModule = { default?: unknown; meta?: unknown };

export function isPanelMeta(value: unknown): value is PanelMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as PanelMeta;
  if (typeof meta.title !== "string" || meta.title.trim() === "") return false;
  if (meta.span !== undefined && ![1, 2, 3, 4, 5].includes(meta.span)) return false;
  if (meta.order !== undefined && !Number.isFinite(meta.order)) return false;
  return true;
}

/** A module that does not match the contract is dropped with a console warning
 * rather than crashing the dashboard. `scripts/check-panels.mjs` catches the
 * same mistake at `npm test` time, statically; this is the runtime guard. */
export function readPanel(id: string, mod: PanelModule): RegisteredPanel | null {
  if (typeof mod.default !== "function") {
    console.warn(`Panel "${id}" has no default-exported component; skipping.`);
    return null;
  }
  if (!isPanelMeta(mod.meta)) {
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
