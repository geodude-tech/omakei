/**
 * Bar height as a percentage of the chart's full height.
 *
 * A day with no spend still gets a hairline (0.5%), and any positive day at
 * least 1.5%, so the axis reads as a row of days rather than a scatter of gaps.
 */
export function barHeightPercent(value: number, max: number): number {
  if (max <= 0) return 0.5;
  return Math.max((value / max) * 100, value > 0 ? 1.5 : 0.5);
}
