import { HarnessMascot } from "../HarnessMascot";
import { harnessMascotAgentId } from "@t3tools/shared/harnessMascots";
import { useAtomValue } from "@effect/atom-react";
import type {
  HarnessDefaultsPatch,
  ServerProvider,
  ServerSettings,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  availableDefaultHarnesses,
  harnessDefaultsControls,
  harnessDefaultsSummary,
} from "@t3tools/shared/harnessDefaults";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const CONFIG = "__harness_config__";

export function HarnessDefaultsSettings() {
  const { connectedEnvironments } = useSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // This computer first, then the other machines in their usual order.
  const environments = [
    ...connectedEnvironments.filter(
      (environment) => environment.environmentId === primaryEnvironmentId,
    ),
    ...connectedEnvironments.filter(
      (environment) => environment.environmentId !== primaryEnvironmentId,
    ),
  ];
  return environments.map((environment) => (
    <EnvironmentHarnessDefaults
      key={environment.environmentId}
      environmentId={environment.environmentId}
      label={environment.label}
      providers={environment.serverConfig?.providers ?? []}
      instances={environment.serverConfig?.settings.providerInstances ?? {}}
    />
  ));
}

function EnvironmentHarnessDefaults({
  environmentId,
  label,
  providers,
  instances,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instances: ServerSettings["providerInstances"];
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.harnessDefaultsState({ environmentId, input: {} }),
  );
  const permission = useAtomValue(
    serverEnvironment.updateHarnessDefaults.permissionAtom(environmentId),
  );
  const runUpdate = useAtomCommand(serverEnvironment.updateHarnessDefaults, {
    reportFailure: true,
  });
  const [pending, setPending] = useState(false);
  // Each harness is one row that opens to its model and options, so a machine with a dozen
  // harnesses is a dozen rows, not fifty dropdowns that mostly say "Last used".
  const [openHarnesses, setOpenHarnesses] = useState<ReadonlySet<string>>(() => new Set());
  const state = query.data;
  const disabled = !permission || pending || !query.isSuccess;
  const available = availableDefaultHarnesses(providers);
  const update = async (patch: HarnessDefaultsPatch) => {
    setPending(true);
    try {
      await runUpdate({ environmentId, input: patch });
    } finally {
      setPending(false);
    }
  };
  const picker = (
    title: string,
    value: string | undefined,
    configLabel: string,
    choices: ReadonlyArray<{ id: string; label: string }>,
    change: (value: string | null) => void,
  ) => (
    <Select
      value={value && choices.some((choice) => choice.id === value) ? value : CONFIG}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) change(next === CONFIG ? null : next);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={title}
        className="min-w-0 w-full @min-[32rem]/settings-row:w-72"
      >
        <SelectValue>
          {choices.find((choice) => choice.id === value)?.label ?? configLabel}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value={CONFIG}>{configLabel}</SelectItem>
        {choices.map((choice) => (
          <SelectItem key={choice.id} value={choice.id}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
  return (
    <SettingsSection id={`harness-defaults-${environmentId}`} title={`Harnesses · ${label}`}>
      <SettingsRow
        id="default-harness"
        title="Default harness"
        description="Defaults for new chats on this server, shared with your other devices. Unset choices use the last choice on this device, then the harness config when there is no history."
        resetAction={
          state?.defaultHarness ? (
            <SettingResetButton
              disabled={disabled}
              label="default harness"
              onClick={() => void update({ defaultHarness: null })}
            />
          ) : null
        }
        control={picker(
          "Default harness",
          state?.defaultHarness,
          "Last used",
          available.map((provider) => ({
            id: provider.instanceId,
            label: provider.displayName ?? provider.instanceId,
          })),
          (id) => void update({ defaultHarness: id as HarnessDefaultsPatch["defaultHarness"] }),
        )}
      />
      {state?.defaultHarness &&
      !available.some((provider) => provider.instanceId === state.defaultHarness) ? (
        <p className="text-sm text-muted-foreground">
          The selected harness is unavailable. New chats use the last-used harness.
        </p>
      ) : null}
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      ) : null}
      {state
        ? available.map((provider) => {
            const controls = harnessDefaultsControls(provider, state);
            const name = provider.displayName ?? provider.instanceId;
            const patch = (
              value: NonNullable<HarnessDefaultsPatch["harnesses"]>[typeof provider.instanceId],
            ) => void update({ harnesses: { [provider.instanceId]: value } });
            const isOpen = openHarnesses.has(provider.instanceId);
            return (
              <div key={provider.instanceId}>
                <SettingsRow
                  id={`harness-${provider.instanceId}`}
                  title={
                    <span className="flex items-center gap-2">
                      <HarnessMascot
                        driver={provider.driver}
                        agentId={harnessMascotAgentId(
                          provider.driver,
                          instances[provider.instanceId]?.config,
                        )}
                        still
                        size={24}
                      />
                      {name}
                    </span>
                  }
                  resetAction={
                    controls.override ? (
                      <SettingResetButton
                        disabled={disabled}
                        label={`${name} defaults`}
                        onClick={() => patch(null)}
                      />
                    ) : null
                  }
                  control={
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={`${name} defaults: ${harnessDefaultsSummary(controls)}`}
                      onClick={() =>
                        setOpenHarnesses((current) => {
                          const next = new Set(current);
                          if (!next.delete(provider.instanceId)) next.add(provider.instanceId);
                          return next;
                        })
                      }
                      className="flex min-w-0 items-center justify-end gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className={cn("truncate", controls.override && "text-foreground")}>
                        {harnessDefaultsSummary(controls)}
                      </span>
                      <ChevronDownIcon
                        aria-hidden
                        className={cn(
                          "size-3.5 shrink-0 transition-transform",
                          !isOpen && "-rotate-90",
                        )}
                      />
                    </button>
                  }
                />
                {isOpen ? (
                  <div className="pl-8">
                    <SettingsRow
                      id={`harness-model-${provider.instanceId}`}
                      title="Model"
                      description="Model for new chats using this harness."
                      control={picker(
                        `${name} model`,
                        controls.override?.model,
                        `Last used (or ${controls.nativeModelLabel})`,
                        provider.models.map((model) => ({ id: model.slug, label: model.name })),
                        (model) => patch({ model }),
                      )}
                    />
                    {controls.options.map((option) => {
                      // Catalog labels are capitalized on their own ("Service
                      // Tier"); after the harness name they read as one sentence.
                      // All-caps words such as "GPU" keep their case.
                      const optionTitle = `${name} ${option.label.replace(/\b[A-Z][a-z]/g, (word) => word.toLowerCase())}`;
                      return (
                        <SettingsRow
                          key={option.id}
                          id={`harness-option-${provider.instanceId}-${option.id}`}
                          title={option.label.replace(/(?!^)\b[A-Z][a-z]/g, (word) =>
                            word.toLowerCase(),
                          )}
                          resetAction={
                            controls.override?.options?.[option.id] ? (
                              <SettingResetButton
                                disabled={disabled}
                                label={optionTitle}
                                onClick={() => patch({ options: { [option.id]: null } })}
                              />
                            ) : null
                          }
                          control={picker(
                            optionTitle,
                            controls.override?.options?.[option.id],
                            `Last used (or ${option.options.find((choice) => choice.id === option.nativeValue)?.label ?? option.nativeValue ?? "Catalog default"})`,
                            option.options.map((choice) => ({
                              id: choice.id,
                              label: choice.label,
                            })),
                            (value) => patch({ options: { [option.id]: value } }),
                          )}
                        />
                      );
                    })}
                  </div>
                ) : null}
                {controls.warnings.map((warning) => (
                  <p key={warning} className="text-sm text-muted-foreground">
                    {warning}
                  </p>
                ))}
              </div>
            );
          })
        : null}
    </SettingsSection>
  );
}
