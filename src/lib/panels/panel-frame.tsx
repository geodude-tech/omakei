/**
 * The card around one panel, and the boundary that keeps it from taking the
 * page down with it.
 *
 * Panels are written by an agent, so one of them will throw eventually. When it
 * does it must cost its own card and nothing else — the moment a bad panel can
 * blank the dashboard is the moment pinning insights stops being safe.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PanelProps } from "@/lib/finance/types.ts";
import type { RegisteredPanel } from "./registry.ts";
import { SPAN_CLASS } from "./span.ts";
import { cn } from "@/lib/utils.ts";

export function PanelFrame({ panel, props }: { panel: RegisteredPanel; props: PanelProps }) {
  const { Component: Panel, title, span } = panel;
  return (
    // `panel-card` pairs with a rule in styles.css: when the body below renders
    // nothing, the whole card is hidden. That is what lets a panel return null
    // on the months it has nothing to say and leave no empty box behind.
    <Card className={cn("panel-card", SPAN_CLASS[span])}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <PanelBoundary id={panel.id}>
          <div className="panel-body">
            <Panel {...props} />
          </div>
        </PanelBoundary>
      </CardContent>
    </Card>
  );
}

class PanelBoundary extends Component<
  { id: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Panel "${this.props.id}" failed to render.`, error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <p className="text-sm text-muted-foreground">
          This panel failed to render. Its error is in the browser console.
        </p>
      );
    }
    return this.props.children;
  }
}
