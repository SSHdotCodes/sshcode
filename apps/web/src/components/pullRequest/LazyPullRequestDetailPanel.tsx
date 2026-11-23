import { lazy, Suspense, type ComponentProps } from "react";

import { PullRequestDetailGhost } from "./PullRequestGhosts";

const DetailPanel = lazy(() =>
  import("./PullRequestDetailPanel").then((module) => ({ default: module.PullRequestDetailPanel })),
);

/** The panel already uses this full-size loading surface while its data loads. */
export function PullRequestDetailPanel(props: ComponentProps<typeof DetailPanel>) {
  return (
    <Suspense fallback={<PullRequestDetailGhost />}>
      <DetailPanel {...props} />
    </Suspense>
  );
}
