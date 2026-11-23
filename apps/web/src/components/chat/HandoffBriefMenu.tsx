import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

type BriefWriterChoice = "leaving" | "chosen" | "off";

/**
 * Who writes the brief for a pending handoff, changeable before the send. The
 * choice is the environment setting, so it holds for every later switch too.
 */
export function HandoffBriefMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly leaving: {
    readonly instanceId: ProviderInstanceId;
    readonly model?: string | undefined;
  };
  readonly modelLabel: (instanceId: ProviderInstanceId, model: string | undefined) => string;
}) {
  const navigate = useNavigate();
  const enabled = useEnvironmentSettings(props.environmentId, (s) => s.handoffBriefEnabled);
  const chosen = useEnvironmentSettings(props.environmentId, (s) => s.handoffBriefModelSelection);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const value: BriefWriterChoice = !enabled ? "off" : chosen === null ? "leaving" : "chosen";
  const leavingLabel = props.modelLabel(props.leaving.instanceId, props.leaving.model);
  const chosenLabel = chosen === null ? null : props.modelLabel(chosen.instanceId, chosen.model);
  const triggerLabel =
    value === "off" ? "no brief" : `brief by ${value === "chosen" ? chosenLabel : leavingLabel}`;

  return (
    <Menu>
      <MenuTrigger
        className="inline-flex min-w-0 items-center gap-0.5 rounded-sm px-1 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label="Who writes the handoff brief"
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
      </MenuTrigger>
      <MenuPopup align="center" className="min-w-56">
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
          Brief for the next model
        </div>
        <MenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (next === value) return;
            if (next === "off") void updateSettings({ handoffBriefEnabled: false });
            if (next === "leaving") {
              void updateSettings({ handoffBriefEnabled: true, handoffBriefModelSelection: null });
            }
            if (next === "chosen") void updateSettings({ handoffBriefEnabled: true });
          }}
        >
          <MenuRadioItem value="leaving">Written by {leavingLabel}</MenuRadioItem>
          {chosenLabel === null ? null : (
            <MenuRadioItem value="chosen">Written by {chosenLabel}</MenuRadioItem>
          )}
          <MenuRadioItem value="off">No brief, history only</MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            if (!enabled) void updateSettings({ handoffBriefEnabled: true });
            void navigate({ to: "/settings/general", hash: "handoff-brief-writer" });
          }}
        >
          Choose a writer model…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
