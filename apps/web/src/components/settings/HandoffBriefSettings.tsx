import { useNavigate } from "@tanstack/react-router";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/**
 * The brief a chat carries when it moves to another model: on or off, and who
 * writes it. Off-switch on the writer row means the model being left writes it.
 */
export function HandoffBriefSettingsRows() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const serverProviders = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const mixedEnabled = useScopedSettingsMixed(["handoffBriefEnabled"]);
  const mixedWriter = useScopedSettingsMixed(["handoffBriefModelSelection"]);

  const providers = serverProviders.filter((provider) => provider.supportsTextGeneration !== false);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      target?.projectId ?? null,
    ),
  );
  const disabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const defaultSelection = resolveAppModelSelectionState(settings, providers);
  const usesChosenWriter = settings.handoffBriefModelSelection !== null;
  const writerSelection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection:
        settings.handoffBriefModelSelection ?? settings.textGenerationModelSelection,
    },
    providers,
  );
  const writerEntry = instanceEntries.find(
    (entry) => entry.instanceId === writerSelection.instanceId,
  );
  const canChooseWriter = instanceEntries.some((entry) => entry.enabled && entry.isAvailable);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    writerSelection.instanceId,
    writerSelection.model,
  );

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["handoffBriefEnabled"]}
        {...searchableSetting("handoff-brief")}
        description="When a chat moves to another model, a brief of the work so far goes with its history: the goal, what's done, what's next."
        control={
          <ScopedSwitch
            settingKeys={["handoffBriefEnabled"]}
            checked={settings.handoffBriefEnabled}
            onCheckedChange={(checked) => updateSettings({ handoffBriefEnabled: Boolean(checked) })}
            aria-label="Handoff brief"
          />
        }
      />
      {settings.handoffBriefEnabled || mixedEnabled ? (
        <SettingsRow
          serverScoped
          settingKeys={["handoffBriefModelSelection"]}
          {...searchableSetting("handoff-brief-writer")}
          description="Off: the model being left writes it, since it knows the work best (your text generation model steps in when that account is out of usage). On: this model always writes it, from the chat's transcript."
          control={
            !hasServerTargets ? (
              <span className="text-xs text-muted-foreground">
                Connect an environment to choose who writes handoff briefs.
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {usesChosenWriter && canChooseWriter ? (
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={writerSelection.instanceId}
                    model={writerSelection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel="Handoff brief writer"
                    {...(mixedWriter ? { triggerLabel: "Mixed" } : {})}
                    {...(environmentId
                      ? {
                          onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                            void navigate({
                              to: "/settings/providers",
                              search: { environmentId, instanceId },
                            });
                          },
                        }
                      : {})}
                    getModelDisabledReason={disabledReason}
                    onInstanceModelChange={(instanceId, model) => {
                      const reason = disabledReason(instanceId, model);
                      if (reason) {
                        toastManager.add({
                          type: "error",
                          title: "Handoff brief writer not saved",
                          description: reason,
                        });
                        return;
                      }
                      updateSettings({
                        handoffBriefModelSelection: pickModelSelection(
                          mixedWriter ? null : writerSelection,
                          instanceId,
                          model,
                        ),
                      });
                    }}
                  />
                ) : null}
                {usesChosenWriter && canChooseWriter && !mixedWriter && writerEntry ? (
                  <TraitsPicker
                    provider={writerEntry.driverKind}
                    models={writerEntry.models}
                    model={writerSelection.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={writerSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={
                      settings.planModeEnabled || selectsPlanAgent(writerSelection.options)
                    }
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(options) =>
                      updateSettings({
                        handoffBriefModelSelection: createModelSelection(
                          writerSelection.instanceId,
                          writerSelection.model,
                          options,
                        ),
                      })
                    }
                  />
                ) : null}
                {!usesChosenWriter && !mixedWriter ? (
                  <span className="text-xs text-muted-foreground">Model being left</span>
                ) : null}
                <Switch
                  mixed={mixedWriter}
                  checked={mixedWriter ? false : usesChosenWriter}
                  disabled={!usesChosenWriter && !canChooseWriter}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      handoffBriefModelSelection: checked
                        ? createModelSelection(
                            defaultSelection.instanceId,
                            defaultSelection.model,
                            defaultSelection.options,
                          )
                        : null,
                    })
                  }
                  aria-label="Choose the handoff brief writer"
                />
              </div>
            )
          }
        />
      ) : null}
    </>
  );
}
