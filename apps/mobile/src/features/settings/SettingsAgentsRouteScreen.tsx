import {
  AGENT_BEHAVIOR_NOTE,
  AGENT_BEHAVIOR_RESET_LABEL,
  AGENT_BEHAVIOR_SLIDERS,
  AGENT_BEHAVIOR_TITLE,
  agentBehaviorLevelsPatch,
  agentBehaviorSliderState,
  agentTokenCostLine,
  withAgentBehaviorLevel,
} from "@t3tools/client-runtime/state/agent-behavior";
import {
  AuthSettingsWriteScope,
  DEFAULT_AGENT_BEHAVIOR,
  type AgentBehaviorLevels,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import type { AppSymbolName } from "../../components/AppSymbol";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentLevelSliderRow } from "./agents/AgentLevelSliderRow";
import { TokenCostLine } from "./agents/TokenCostLine";
import { useSyncedAgentBehavior } from "./agents/useSyncedAgentBehavior";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

const LOCKED_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };
const UNLOCKED_SYMBOL: AppSymbolName = { ios: "lock.open", android: "lock" };

function sameLevels(left: AgentBehaviorLevels, right: AgentBehaviorLevels): boolean {
  return AGENT_BEHAVIOR_SLIDERS.every((slider) => left[slider.key] === right[slider.key]);
}

/**
 * Settings > Agents. Every connected server that runs agents gets each change, so the Mac
 * and every machine follow the phone; the screen shows the most recent choice from any device.
 * The screen opens locked so a stray tap while scrolling can't change how every agent works;
 * the lock at the top unlocks it until the screen closes.
 */
export function SettingsAgentsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { targets, levels: synced } = useSyncedAgentBehavior();
  const writable = useEnvironmentsWithScope(targets, AuthSettingsWriteScope);
  const syncTargets = targets.filter((target) => writable.has(target.environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "agent settings update",
    reportFailure: true,
  });
  // A change shows at once; the servers' value takes over as soon as it moves.
  const [pending, setPending] = useState<{
    readonly levels: AgentBehaviorLevels;
    readonly from: AgentBehaviorLevels;
  } | null>(null);
  if (pending !== null && !sameLevels(pending.from, synced)) setPending(null);
  const shown = pending?.levels ?? synced;
  const disabled = syncTargets.length === 0;
  const [unlocked, setUnlocked] = useState(false);
  const locked = !unlocked && !disabled;
  // A tap on a locked control lights up the hint for a moment.
  const [nudged, setNudged] = useState(false);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endNudge = () => {
    if (nudgeTimer.current !== null) clearTimeout(nudgeTimer.current);
    nudgeTimer.current = null;
    setNudged(false);
  };
  const nudge = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    // A second tap restarts the highlight instead of ending on the first tap's timer.
    if (nudgeTimer.current !== null) clearTimeout(nudgeTimer.current);
    setNudged(true);
    nudgeTimer.current = setTimeout(endNudge, 1200);
  };
  useEffect(
    () => () => {
      if (nudgeTimer.current !== null) clearTimeout(nudgeTimer.current);
    },
    [],
  );
  const primaryColor = useUniwindTheme()["--color-primary"];

  const write = (next: AgentBehaviorLevels) => {
    if (disabled || locked || sameLevels(next, shown)) return;
    const entry = { levels: next, from: synced };
    setPending(entry);
    const writes = syncTargets
      .filter(({ environmentId }) => readEnvironmentScope(environmentId, AuthSettingsWriteScope))
      .map(({ environmentId }) =>
        updateSettings({ environmentId, input: { patch: agentBehaviorLevelsPatch(next) } }),
      );
    void Promise.all(writes).then((results) => {
      if (results.every((result) => result._tag === "Failure"))
        setPending((current) => (current === entry ? null : current));
    });
  };

  return (
    <SettingsScreen
      title={AGENT_BEHAVIOR_TITLE}
      actions={
        disabled
          ? undefined
          : [
              {
                accessibilityLabel: locked ? "Unlock agent settings" : "Lock agent settings",
                icon: locked ? LOCKED_SYMBOL : UNLOCKED_SYMBOL,
                // The native toolbar has no selected look; tint the glyph instead.
                ...(nudged ? { tintColor: primaryColor } : {}),
                onPress: () => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
                    () => undefined,
                  );
                  endNudge();
                  setUnlocked(locked);
                },
              },
            ]
      }
    >
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm text-foreground-muted">
          {disabled ? "Connect a machine to change how agents work." : AGENT_BEHAVIOR_NOTE}
        </Text>
        {disabled ? null : (
          <Text
            className={
              nudged
                ? "-mt-2 px-2 text-sm font-t3-medium text-primary"
                : "-mt-2 px-2 text-sm text-foreground-muted"
            }
          >
            {locked
              ? "Locked so a stray tap can't change anything. Tap the lock at the top to make changes."
              : "Unlocked. Changes save right away and lock again when you leave."}
          </Text>
        )}
        {AGENT_BEHAVIOR_SLIDERS.map((slider) => {
          const { options, index, option, defaultIndex } = agentBehaviorSliderState(slider, shown);
          const footnote =
            slider.key === "tokens" ? (
              agentTokenCostLine(shown.tokens, {}) === null ? null : (
                <TokenCostLine level={shown.tokens} />
              )
            ) : option.hint ? (
              <Text className="text-xs text-foreground-muted">{option.hint}</Text>
            ) : null;
          return (
            <SettingsSection key={slider.key}>
              <AgentLevelSliderRow
                label={slider.title}
                options={options.map((candidate) => candidate.label)}
                index={index}
                defaultIndex={defaultIndex}
                copy={option.copy}
                footnote={footnote}
                disabled={disabled}
                locked={locked}
                onLockedPress={nudge}
                onChange={(stop) => {
                  const level = slider.levels[stop]?.level;
                  if (level !== undefined) write(withAgentBehaviorLevel(shown, slider.key, level));
                }}
              />
            </SettingsSection>
          );
        })}
        <Pressable
          accessibilityRole="button"
          className="items-center py-2 active:opacity-60 disabled:opacity-40"
          disabled={disabled || locked || sameLevels(shown, DEFAULT_AGENT_BEHAVIOR)}
          onPress={() => write(DEFAULT_AGENT_BEHAVIOR)}
        >
          <Text
            className={
              disabled || locked || sameLevels(shown, DEFAULT_AGENT_BEHAVIOR)
                ? "text-base text-foreground-muted"
                : "text-base text-primary"
            }
          >
            {AGENT_BEHAVIOR_RESET_LABEL}
          </Text>
        </Pressable>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
