import {
  AGENT_BEHAVIOR_NOTE,
  AGENT_BEHAVIOR_RESET_LABEL,
  AGENT_BEHAVIOR_RESET_PATCH,
  AGENT_BEHAVIOR_SLIDERS,
  AGENT_BEHAVIOR_TITLE,
  agentBehaviorPatch,
  agentBehaviorSliderState,
  agentTokenCostLine,
  agentTokenHarness,
  weeklyChatsByHarness,
  type AgentBehaviorSlider,
} from "@t3tools/client-runtime/state/agent-behavior";
import {
  agentBehaviorLevels,
  DEFAULT_AGENT_BEHAVIOR,
  type AgentBehaviorLevels,
  type ProviderInstanceId,
  type UnifiedSettings,
} from "@t3tools/contracts";
import type { AgentTokenLevel } from "@t3tools/shared/agentTokenEstimates";
import { harnessMascotAgentId } from "@t3tools/shared/harnessMascots";
import { LockIcon, LockOpenIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentLevelSlider } from "./AgentLevelSlider";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const selectAgentBehavior = (settings: UnifiedSettings) => settings.agentBehavior;

/**
 * Settings > Agents: five stepped sliders for how agents work in every chat on this server.
 * The page opens locked so a stray click can't change every agent; Unlock lasts until you leave.
 */
export function AgentsSettings() {
  const { environment } = useSettingsScope();
  const levels = agentBehaviorLevels(useScopedSettings(selectAgentBehavior));
  const updateSettings = useUpdateScopedSettings();
  const canWrite = useScopedSettingsWriteAllowed();
  const [unlocked, setUnlocked] = useState(false);
  // A click on a locked slider lights up the lock for a moment.
  const [nudged, setNudged] = useState(false);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (nudgeTimer.current !== null) clearTimeout(nudgeTimer.current);
    },
    [],
  );
  if (!environment?.serverConfig)
    return (
      <SettingsPageContainer>
        Connect an environment to change how agents work.
      </SettingsPageContainer>
    );
  const changed = AGENT_BEHAVIOR_SLIDERS.some(
    (slider) => levels[slider.key] !== DEFAULT_AGENT_BEHAVIOR[slider.key],
  );
  const locked = !unlocked || !canWrite;
  const endNudge = () => {
    if (nudgeTimer.current !== null) clearTimeout(nudgeTimer.current);
    nudgeTimer.current = null;
    setNudged(false);
  };
  const nudge = () => {
    // A second click restarts the highlight instead of ending on the first click's timer.
    if (nudgeTimer.current !== null) clearTimeout(nudgeTimer.current);
    setNudged(true);
    nudgeTimer.current = setTimeout(endNudge, 1200);
  };
  return (
    <SettingsPageContainer>
      <SettingsSection title={AGENT_BEHAVIOR_TITLE} variant="plain" id="agents">
        <div className="space-y-3">
          <p className="px-3 text-xs leading-normal text-muted-foreground sm:px-4">
            {AGENT_BEHAVIOR_NOTE}
          </p>
          <div className="flex items-center justify-between gap-3 px-3 sm:px-4">
            <p
              className={cn(
                "text-xs leading-normal transition-colors duration-150",
                nudged ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {!canWrite
                ? "Only the owner of this machine can change these."
                : locked
                  ? "Locked so a stray click can't change anything."
                  : "Unlocked. Changes save right away and lock again when you leave this page."}
            </p>
            {canWrite ? (
              <Button
                variant="outline"
                size="xs"
                aria-label={locked ? "Unlock agent settings" : "Lock agent settings"}
                className={cn(
                  // Same width locked and unlocked, so it doesn't shift when toggled.
                  "min-w-[4.75rem] shrink-0 transition-shadow duration-150",
                  nudged && "ring-2 ring-primary/60 ring-offset-1 ring-offset-background",
                )}
                onClick={() => {
                  endNudge();
                  setUnlocked(locked);
                }}
              >
                {locked ? <LockIcon /> : <LockOpenIcon />}
                {locked ? "Unlock" : "Lock"}
              </Button>
            ) : null}
          </div>
          {AGENT_BEHAVIOR_SLIDERS.map((slider) => (
            <SettingsGroup key={slider.key}>
              <AgentLevelRow
                slider={slider}
                levels={levels}
                locked={locked}
                onLockedPress={nudge}
                onChange={(index) =>
                  updateSettings(agentBehaviorPatch(slider.key, slider.levels[index]!.level))
                }
              />
            </SettingsGroup>
          ))}
          <div className="flex justify-end px-1">
            <Button
              variant="link"
              size="xs"
              disabled={!changed || locked}
              onClick={() => updateSettings(AGENT_BEHAVIOR_RESET_PATCH)}
            >
              {AGENT_BEHAVIOR_RESET_LABEL}
            </Button>
          </div>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function AgentLevelRow(props: {
  readonly slider: AgentBehaviorSlider;
  readonly levels: AgentBehaviorLevels;
  readonly locked: boolean;
  readonly onLockedPress: () => void;
  readonly onChange: (index: number) => void;
}) {
  const { slider, levels } = props;
  const { options, index, option, defaultIndex } = agentBehaviorSliderState(slider, levels);
  return (
    <SettingsRow
      id={`agents-${slider.key}`}
      serverScoped
      compactControl
      title={slider.title}
      control={<span className="text-sm text-muted-foreground">{option.label}</span>}
    >
      <div className="space-y-2 pb-3">
        <AgentLevelSlider
          label={slider.title}
          options={options.map((candidate) => candidate.label)}
          index={index}
          defaultIndex={defaultIndex}
          onChange={props.onChange}
          locked={props.locked}
          onLockedPress={props.onLockedPress}
        />
        <p className="max-w-xl text-xs leading-normal text-muted-foreground">{option.copy}</p>
        {slider.key === "tokens" ? (
          <TokenCostLine level={levels.tokens} />
        ) : option.hint ? (
          <p className="text-xs text-muted-foreground/80">{option.hint}</p>
        ) : null}
      </div>
    </SettingsRow>
  );
}

/** Only measured levels have a line; without numbers there is no line and no placeholder. */
function TokenCostLine({ level }: { readonly level: AgentTokenLevel }) {
  if (agentTokenCostLine(level, {}) === null) return null;
  return <MeasuredTokenCostLine level={level} />;
}

function MeasuredTokenCostLine({ level }: { readonly level: AgentTokenLevel }) {
  const { environment } = useSettingsScope();
  const shells = useThreadShells();
  const nowMs = useNowMinuteMs();
  const chats = useMemo(() => {
    if (!environment?.serverConfig) return {};
    const config = environment.serverConfig;
    const harnessOf = (instanceId: ProviderInstanceId) => {
      const driver = config.providers.find(
        (provider) => provider.instanceId === instanceId,
      )?.driver;
      return agentTokenHarness(
        driver,
        harnessMascotAgentId(driver, config.settings.providerInstances[instanceId]?.config),
      );
    };
    return weeklyChatsByHarness(
      shells
        .filter((shell) => shell.environmentId === environment.environmentId)
        .map((shell) => ({
          harness: harnessOf(shell.providerInstanceId),
          activeAt: shell.activityLastAt ?? shell.latestUserMessageAt,
        })),
      nowMs,
    );
  }, [environment, nowMs, shells]);
  const line = agentTokenCostLine(level, chats);
  if (line === null) return null;
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      {line.shown.lineBeforeHarness}
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              className="cursor-help underline decoration-dotted underline-offset-2 outline-none focus-visible:text-foreground"
            />
          }
        >
          {line.shown.label}
        </TooltipTrigger>
        <TooltipPopup side="top">
          <table className="tabular-nums">
            <tbody>
              {line.rows.map((row) => (
                <tr key={row.harness}>
                  <td className="pe-3">{row.label}</td>
                  <td className="pe-3 text-end">{row.tokens} tokens</td>
                  <td className="pe-3 text-end">{row.usage} usage</td>
                  <td className="text-end text-muted-foreground">{row.measuredLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TooltipPopup>
      </Tooltip>
      {line.shown.lineAfterHarness}
    </p>
  );
}
