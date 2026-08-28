/**
 * The region panels are drawn into: the same five-column grid the built-in
 * cards used, so a migrated panel lands exactly where its card was.
 *
 * Panels wait for `ready`, which the dashboard flips after first paint. The
 * stat row must be on screen before any panel computes anything.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { PanelProps } from "@/lib/finance/types.ts";
import { PanelFrame } from "./panel-frame.tsx";
import { panels } from "./registry.ts";
import { SPAN_CLASS } from "./span.ts";
import { cn } from "@/lib/utils.ts";

export function PanelGrid({ ready, ...props }: PanelProps & { ready: boolean }) {
  if (panels.length === 0) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      {panels.map((panel) =>
        ready ? (
          <PanelFrame key={panel.id} panel={panel} props={props} />
        ) : (
          // Placeholders carry each panel's real title and width, so the grid
          // does not reflow when the panels arrive.
          <Card key={panel.id} className={cn(SPAN_CLASS[panel.span])}>
            <CardHeader>
              <CardTitle>{panel.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <Skeleton className="h-40" />
            </CardContent>
          </Card>
        ),
      )}
    </div>
  );
}
