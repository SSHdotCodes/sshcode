import { type CSSProperties, memo } from "react";

import {
  providerInstanceInitials,
  providerInstanceMark,
} from "@t3tools/client-runtime/state/provider-instance-display";

import { ProviderDriverKind } from "@t3tools/contracts";
import { ClaudeAI, GeminiIcon, Icon, OpenAI } from "../Icons";

import { cn } from "~/lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { ProviderPackageIcon } from "./ProviderPackageIcon";
import {
  AcpRegistryAgentIcon,
  officialAcpRegistryIconUrlForAgentId,
  resolveOfficialAcpRegistryIconUrl,
} from "../settings/AcpRegistryIcon";

const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  // Antigravity runs Google's models, so it wears Gemini's mark, as Claude Code wears Claude's.
  [ProviderDriverKind.make("antigravity")]: GeminiIcon,
};

const PROVIDER_TEXT_COLOR_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "text-black dark:text-white",
  [ProviderDriverKind.make("claudeAgent")]: "text-[#d97757]",
  [ProviderDriverKind.make("antigravity")]: "text-[#5b87bf]",
};

/** Brand text color for a provider label; package glyphs supply theirs as CSS variables. */
export function providerTextColor(driverKind: ProviderDriverKind): {
  readonly className?: string;
  readonly style?: CSSProperties;
} {
  const icon = providerClients.get(driverKind)?.icon;
  if (icon) {
    return {
      className: "text-(--icon-light) dark:text-(--icon-dark)",
      style: { "--icon-light": icon.fill.light, "--icon-dark": icon.fill.dark } as CSSProperties,
    };
  }
  const className = PROVIDER_TEXT_COLOR_BY_PROVIDER[driverKind];
  return className ? { className } : {};
}

export function resolveProviderInstanceAcpRegistryIconUrl(input: {
  readonly driverKind: ProviderDriverKind;
  readonly agentId?: string | undefined;
  readonly iconUrl?: string | undefined;
}): string | null {
  // Antigravity draws Gemini's own coloured mark, not a registry glyph.
  if (input.driverKind === "antigravity") return null;
  if (input.driverKind !== "acpRegistry")
    return resolveOfficialAcpRegistryIconUrl(input.iconUrl ?? null);
  return (
    resolveOfficialAcpRegistryIconUrl(input.iconUrl ?? null) ??
    officialAcpRegistryIconUrlForAgentId(input.agentId?.trim() || null)
  );
}

/** A one-pixel outline in every direction, in the color of the surface behind the mark. */
function markHalo(surface: string): string {
  return [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ]
    .map(([x, y]) => `${x}px ${y}px 0 ${surface}`)
    .join(", ");
}

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  accentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  /** An added account of a provider: a small character at the glyph's corner tells it from the provider's own. */
  showBadge?: boolean;
  className?: string;
  iconClassName?: string;
  statusDotClassName?: string;
  indicatorBackground?: string;
}) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const packageIcon = providerClients.get(props.driverKind)?.icon;
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";
  const accentStyle = props.accentColor
    ? ({ "--provider-accent": props.accentColor } as CSSProperties)
    : undefined;
  const acpRegistryIconUrl = resolveProviderInstanceAcpRegistryIconUrl({
    driverKind: props.driverKind,
    agentId: props.acpRegistryAgentId,
    iconUrl: props.acpRegistryIconUrl,
  });
  const isAcpRegistry = props.driverKind === "acpRegistry" || acpRegistryIconUrl !== null;

  return (
    <span
      className={cn(
        "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={accentStyle}
      data-provider-accent-color={props.accentColor}
    >
      {isAcpRegistry ? (
        <AcpRegistryAgentIcon
          // The search-tile radius would crop most of the glyph at these
          // inline sizes.
          className={cn("size-5 rounded-none bg-transparent", props.iconClassName)}
          fallbackClassName="size-full"
          icon={acpRegistryIconUrl}
        />
      ) : packageIcon ? (
        <ProviderPackageIcon
          icon={packageIcon}
          className={cn("size-5 shrink-0", props.iconClassName)}
          aria-hidden
        />
      ) : Icon ? (
        <Icon className={cn("size-5 shrink-0", props.iconClassName)} aria-hidden />
      ) : (
        <span className={cn("text-3xs font-semibold leading-none", props.iconClassName)}>
          {providerInstanceInitials(props.displayName)}
        </span>
      )}
      {props.statusDotClassName ? (
        <span
          className={cn(
            "pointer-events-none absolute -left-0.5 -top-0.5 z-10 size-2 rounded-full",
            props.statusDotClassName,
          )}
          style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
          aria-hidden
        />
      ) : null}
      {props.showBadge ? (
        // A small character tucked under the glyph's corner, like a subscript.
        // No bubble and no dot: those read as unread or needs-input. The halo
        // of the surface behind it keeps it clear of the glyph's strokes.
        <span
          className={cn(
            "pointer-events-none absolute -right-1 -bottom-1 z-10 select-none text-4xs leading-none font-bold",
            props.accentColor ? "text-(--provider-accent)" : "text-foreground",
          )}
          style={{ textShadow: markHalo(indicatorBackground) }}
          data-provider-instance-mark=""
          aria-hidden
        >
          {providerInstanceMark(props.displayName)}
        </span>
      ) : null}
    </span>
  );
});
