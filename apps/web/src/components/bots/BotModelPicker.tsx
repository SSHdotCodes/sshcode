import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { readThreadShells } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";

/**
 * The model of the user's most recent chat on this server, the default for a new bot. Bot
 * chats are already out of the list, so a second bot starts from a real chat's model.
 */
export function latestChatModel(environmentId: EnvironmentId): ModelSelection | null {
  let latest: { at: string; selection: ModelSelection } | null = null;
  for (const shell of readThreadShells()) {
    if (shell.environmentId !== environmentId || shell.archivedAt !== null) continue;
    if (shell.lineage.relationshipToParent === "subagent") continue;
    const at = shell.latestUserMessageAt ?? shell.updatedAt;
    if (latest === null || at > latest.at) latest = { at, selection: shell.modelSelection };
  }
  return latest?.selection ?? null;
}

/** The app's model picker, for a bot's model: any model the server offers, no nudges. */
export function BotModelPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly value: ModelSelection | null;
  readonly disabled?: boolean;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const { environmentId, value } = props;
  const navigate = useNavigate();
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
      ),
    [providers, settings],
  );
  const fallback = instanceEntries.find((entry) => entry.enabled && entry.isAvailable);
  const instanceId = value?.instanceId ?? fallback?.instanceId ?? ("" as ProviderInstanceId);
  const model = value?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, instanceId, model),
    [settings, providers, instanceId, model],
  );
  return (
    <ProviderModelPicker
      environmentId={environmentId}
      disabled={props.disabled ?? false}
      activeInstanceId={instanceId}
      model={model}
      activeModelOptions={value?.options}
      lockedProvider={null}
      instanceEntries={instanceEntries}
      modelOptionsByInstance={modelOptionsByInstance}
      isComposerOwned={false}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      triggerAriaLabel="Bot model"
      {...(model === "" ? { triggerLabel: "Pick a model" } : {})}
      onOpenProviderSetup={(setupInstanceId) =>
        void navigate({
          to: "/settings/providers",
          search: { environmentId, instanceId: setupInstanceId },
        })
      }
      onInstanceModelChange={(nextInstanceId, nextModel, options) =>
        props.onChange({
          instanceId: nextInstanceId,
          model: nextModel,
          ...(options && options.length > 0 ? { options } : {}),
        })
      }
    />
  );
}
