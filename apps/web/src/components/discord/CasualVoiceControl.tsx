import { useState } from "react";
import {
  ProviderInstanceId,
  type CasualVoiceMode,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  casualVoiceCloudOptions,
  casualVoiceEffortDescriptor,
  casualVoiceEffortValue,
} from "@t3tools/shared/casualVoice";
import { useCasualVoice } from "./useCasualVoice";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";

const MODE_COPY: Record<CasualVoiceMode, string> = {
  local: "Stays on this computer.",
  hybrid: "Steer replies use the cloud model. Those calls leave out your style examples.",
  cloud: "This sends your style examples to the cloud provider.",
};

export function CasualVoiceControl({
  environmentId,
  threadId,
  plain = false,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** Header control for the normal layout. Discord mode keeps its own summary. */
  plain?: boolean;
}) {
  const { state, configure, allowed, backendAllowed, refresh } = useCasualVoice(
    environmentId,
    threadId,
  );
  const [url, setUrl] = useState("");
  const [model, setModel] = useState("");
  const [styleFile, setStyleFile] = useState("");
  const [error, setError] = useState(false);
  const ready = state.backend || state.cloudBackend;
  const mode = state.mode ?? "local";
  const cloud =
    state.cloudBackend?.kind === "provider"
      ? state.cloudBackend
      : state.backend?.kind === "provider"
        ? state.backend
        : null;
  const cloudModel = state.models.find(
    (item) =>
      item.instanceId === cloud?.modelSelection.instanceId &&
      item.model === cloud.modelSelection.model,
  );
  const effortDescriptor = casualVoiceEffortDescriptor(cloudModel?.optionDescriptors);
  const storedEffort = effortDescriptor
    ? cloud?.modelSelection.options?.find((option) => option.id === effortDescriptor.id)
    : undefined;
  const effort = casualVoiceEffortValue(
    effortDescriptor,
    typeof storedEffort?.value === "string" ? storedEffort.value : undefined,
  );
  const stylePath = state.backend?.styleFile || state.cloudBackend?.styleFile;
  return (
    <details
      className={plain ? "relative [-webkit-app-region:no-drag]" : "relative text-xs"}
      onToggle={(event) => {
        if (event.currentTarget.open) void refresh();
      }}
    >
      <summary
        className={
          plain
            ? "flex h-8 cursor-pointer list-none items-center rounded-lg px-2.5 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
            : "cursor-pointer whitespace-nowrap"
        }
      >
        {plain ? "Casual voice" : "casual voice"}
        {!state.enabled ? " off" : plain ? "" : !ready ? ": choose model" : ""}
      </summary>
      <div
        className={
          plain
            ? "absolute right-0 top-full z-50 mt-1 grid w-80 gap-3 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
            : "absolute right-0 top-7 z-50 grid w-80 gap-3 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
        }
      >
        <label className="flex items-center justify-between gap-3">
          casual voice for this chat
          <Switch
            checked={state.enabled}
            disabled={!allowed}
            onCheckedChange={(enabled) => void configure({ enabled })}
          />
        </label>
        <label className="grid gap-1">
          voice mode
          <select
            aria-label="Casual voice mode"
            disabled={!backendAllowed}
            className="w-full rounded border bg-background p-2"
            value={mode}
            onChange={(event) => void configure({ mode: event.target.value as CasualVoiceMode })}
          >
            <option value="local">Local</option>
            <option value="hybrid">Local + cloud for steers</option>
            <option value="cloud">Cloud only</option>
          </select>
        </label>
        <p>{MODE_COPY[mode]}</p>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <select
            aria-label="Cloud model"
            disabled={!backendAllowed}
            className="min-w-0 rounded border bg-background p-2"
            value={
              cloud
                ? JSON.stringify([cloud.modelSelection.instanceId, cloud.modelSelection.model])
                : ""
            }
            onChange={(event) => {
              const chosen = state.models.find(
                (item) => JSON.stringify([item.instanceId, item.model]) === event.target.value,
              );
              if (!chosen) return;
              const options = casualVoiceCloudOptions(chosen.optionDescriptors);
              void configure({
                cloudBackend: {
                  kind: "provider",
                  styleFile: stylePath ?? "",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make(chosen.instanceId),
                    model: chosen.model,
                    ...(options ? { options } : {}),
                  },
                },
              });
            }}
          >
            <option value="">choose a cloud model</option>
            {state.models.map((item) => (
              <option
                key={JSON.stringify([item.instanceId, item.model])}
                value={JSON.stringify([item.instanceId, item.model])}
              >
                {item.name}
              </option>
            ))}
          </select>
          {effortDescriptor ? (
            <select
              aria-label="Cloud effort"
              disabled={!backendAllowed || !cloud}
              className="rounded border bg-background p-2"
              value={effort ?? ""}
              onChange={(event) => {
                if (!cloud) return;
                const options = casualVoiceCloudOptions(
                  effortDescriptor ? [effortDescriptor] : cloudModel?.optionDescriptors,
                  event.target.value,
                  cloud.modelSelection.options,
                );
                void configure({
                  cloudBackend: {
                    ...cloud,
                    modelSelection: { ...cloud.modelSelection, ...(options ? { options } : {}) },
                  },
                });
              }}
            >
              {effortDescriptor.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <label className="flex items-center justify-between gap-3">
          save cloud rewrites for training
          <Switch
            checked={state.saveTraining !== false}
            disabled={!backendAllowed}
            onCheckedChange={(saveTraining) => void configure({ saveTraining })}
          />
        </label>
        <details>
          <summary className="cursor-pointer">local style file</summary>
          <div className="mt-2 grid gap-2">
            <input
              aria-label="Style file path"
              placeholder="path to STYLE.md (optional)"
              value={styleFile}
              onChange={(event) => setStyleFile(event.target.value)}
              className="rounded border bg-background p-2"
            />
            <p>
              reads this guide and a small sample from messages.jsonl beside it. cloud steer calls
              leave them out.
            </p>
            {stylePath ? <p className="break-all">{stylePath}</p> : null}
            <Button
              size="sm"
              disabled={!backendAllowed || !ready}
              onClick={() => {
                const patch: {
                  backend?: NonNullable<typeof state.backend>;
                  cloudBackend?: NonNullable<typeof state.cloudBackend>;
                } = {};
                if (state.backend) patch.backend = { ...state.backend, styleFile };
                if (state.cloudBackend) patch.cloudBackend = { ...state.cloudBackend, styleFile };
                if (patch.backend || patch.cloudBackend) void configure(patch);
              }}
            >
              use style file
            </Button>
          </div>
        </details>
        <details>
          <summary className="cursor-pointer">local endpoint</summary>
          <div className="mt-2 grid gap-2">
            <input
              aria-label="Endpoint URL"
              placeholder="endpoint URL, including /v1/"
              className="rounded border bg-background p-2"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <input
              aria-label="Endpoint model id"
              placeholder="model id"
              className="rounded border bg-background p-2"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            {state.backend?.kind === "local" ? (
              <p>
                using {state.backend.model} at {state.backend.url}
              </p>
            ) : null}
            <Button
              size="sm"
              disabled={!backendAllowed || !url || !model}
              onClick={() =>
                void configure({
                  backend: { kind: "local", url, model, styleFile: stylePath ?? "" },
                  ...(state.backend?.kind === "provider" && state.cloudBackend?.kind !== "provider"
                    ? { cloudBackend: state.backend }
                    : {}),
                }).then((ok) => setError(!ok))
              }
            >
              use endpoint
            </Button>
            {error ? <p role="alert">couldn’t save. check the URL and try again.</p> : null}
          </div>
        </details>
      </div>
    </details>
  );
}
