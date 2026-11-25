import type { ProviderDriverKind, ProviderOptionDescriptor } from "@t3tools/contracts";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";
import { ZapIcon } from "lucide-react";
import { UltrafastIcon } from "../Icons";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";

/** An ACP agent's Speed select (Devin): "fast", which Devin's SWE models call Lightning, against "standard". */
export function acpSpeedChoices(descriptor: ProviderOptionDescriptor) {
  if (descriptor.id !== "speed" || descriptor.type !== "select") return null;
  const on = descriptor.options.find(({ id }) => id === "fast");
  const off = descriptor.options.find(({ id }) => id === "standard");
  return on && off ? { on, off } : null;
}

/**
 * A speed setting with only two states (Fast mode on or off), which the composer flips with one
 * click on its bolt instead of opening a menu. `next` is the value a click sets.
 */
export function speedToggleChoice(
  provider: ProviderDriverKind,
  descriptor: ProviderOptionDescriptor,
): { name: string; on: boolean; next: string | boolean } | null {
  if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
    const on = descriptor.currentValue === true;
    return { name: "Fast mode", on, next: !on };
  }
  if (descriptor.type !== "select" || descriptor.options.length !== 2) return null;
  const acpSpeed = acpSpeedChoices(descriptor);
  if (acpSpeed) {
    const on = getProviderOptionCurrentValue(descriptor) === acpSpeed.on.id;
    return { name: acpSpeed.on.label, on, next: on ? acpSpeed.off.id : acpSpeed.on.id };
  }
  if (provider !== "codex" || descriptor.id !== "serviceTier") return null;
  const fast = descriptor.options.find(({ label }) => label === "Fast");
  const normal = descriptor.options.find((option) => option !== fast);
  if (!fast || !normal) return null;
  const on = getProviderOptionCurrentValue(descriptor) === fast.id;
  return { name: "Fast mode", on, next: on ? normal.id : fast.id };
}

export function getTraitsSpeedDisplay(
  provider: ProviderDriverKind,
  descriptor: ProviderOptionDescriptor,
): { label: string; speedIcon: "fast" | "ultrafast" | null } | null {
  if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
    return {
      label: descriptor.currentValue === true ? "Fast" : "Normal",
      speedIcon: descriptor.currentValue === true ? "fast" : null,
    };
  }
  const acpSpeed = acpSpeedChoices(descriptor);
  if (acpSpeed) {
    const fast = getProviderOptionCurrentValue(descriptor) === acpSpeed.on.id;
    return {
      label: fast ? acpSpeed.on.label : acpSpeed.off.label,
      speedIcon: fast ? "fast" : null,
    };
  }
  if (provider !== "codex" || descriptor.id !== "serviceTier" || descriptor.type !== "select") {
    return null;
  }
  const currentValue = getProviderOptionCurrentValue(descriptor);
  const fastTier = descriptor.options.find(({ label }) => label === "Fast");
  const ultrafastTier = descriptor.options.find(({ label }) => label === "Ultrafast");
  if (
    ((fastTier || ultrafastTier) && currentValue === "default") ||
    (fastTier && currentValue === fastTier.id) ||
    (ultrafastTier && currentValue === ultrafastTier.id)
  ) {
    return {
      label: descriptor.options.find(({ id }) => id === currentValue)?.label ?? "Normal",
      speedIcon:
        ultrafastTier && currentValue === ultrafastTier.id
          ? "ultrafast"
          : fastTier && currentValue === fastTier.id
            ? "fast"
            : null,
    };
  }
  return null;
}

export function TraitsSpeedIcon({
  provider,
  speedIcon,
  size = "sm",
}: {
  provider: ProviderDriverKind;
  speedIcon: "fast" | "ultrafast";
  size?: ComposerControlSize;
}) {
  return (
    <>
      <ComposerControlIcon
        icon={speedIcon === "ultrafast" ? UltrafastIcon : ZapIcon}
        size={size}
        className={cn(
          "fill-current opacity-80",
          size === "xs"
            ? "text-current"
            : provider === "claudeAgent"
              ? "text-[#d97757]"
              : "text-foreground",
        )}
      />
      <span className="sr-only">
        {speedIcon === "ultrafast" ? "Ultrafast mode on" : "Fast mode on"}
      </span>
    </>
  );
}

/** Fast mode in the traits trigger: a bolt that strikes every few seconds instead of the word. */
export function TraitsSpeedBolt({
  provider: _provider,
  speedIcon,
  size = "sm",
  spaced,
}: {
  provider: ProviderDriverKind;
  speedIcon: "fast" | "ultrafast";
  size?: ComposerControlSize;
  spaced: boolean;
}) {
  // Lightning yellow for every provider. The color sits on the icon too: the composer control
  // greys out any svg without one.
  const color = "text-yellow-500 dark:text-yellow-400";
  return (
    <span
      ref={observeVisibleAnimation}
      aria-hidden="true"
      data-speed={speedIcon}
      className={cn(
        "traits-speed-bolt relative inline-flex items-center justify-center align-[-0.125em]",
        spaced && (size === "xs" ? "ms-0.5" : "ms-1"),
        color,
      )}
    >
      <span className="traits-speed-bolt-glow absolute inset-0 rounded-full bg-current blur-xs" />
      <ComposerControlIcon
        icon={speedIcon === "ultrafast" ? UltrafastIcon : ZapIcon}
        size={size}
        className={cn(
          "traits-speed-bolt-icon relative fill-current",
          color,
          size === "sm" && "size-3.5",
        )}
      />
    </span>
  );
}
