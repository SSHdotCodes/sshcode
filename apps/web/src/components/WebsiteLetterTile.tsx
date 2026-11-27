import { websiteLetterTile } from "@t3tools/shared/favicon";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * Stands in for a website icon when Website icons is off: the site's first
 * letter on a muted hue, drawn locally. `size` is the icon's edge in pixels;
 * pass the replaced icon's corner radius in `className`. Renders `fallback`
 * when the site has no usable hostname.
 */
export function WebsiteLetterTile(props: {
  site: string | null | undefined;
  size: number;
  className?: string;
  fallback?: ReactNode;
}) {
  const tile = websiteLetterTile(props.site);
  if (tile === null) return props.fallback ?? null;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center font-medium leading-none text-white",
        props.className,
      )}
      style={{
        width: props.size,
        height: props.size,
        backgroundColor: tile.background,
        fontSize: Math.round(props.size * 0.6),
      }}
    >
      {tile.letter}
    </span>
  );
}
