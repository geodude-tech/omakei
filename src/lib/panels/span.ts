/**
 * Grid widths, written out in full: Tailwind scans source text and cannot see
 * a class name built by interpolation.
 */
export const SPAN_CLASS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  4: "lg:col-span-4",
  5: "lg:col-span-5",
};
