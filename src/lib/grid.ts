/**
 * Column span for the last cell in a wrapping grid, so it stretches to fill
 * whatever is left of its row.
 *
 * `n` cells in a `cols`-wide grid: the last cell sits at index `n - 1`, with
 * `(n - 1) % cols` cells ahead of it in its row, so `cols - ((n - 1) % cols)`
 * slots remain for it to cover.
 */
export function trailingCellSpan(n: number, cols: number): number {
  return cols - ((n - 1) % cols);
}
