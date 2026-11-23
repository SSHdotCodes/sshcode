import { useState } from "react";
import { View, Pressable, TextInput, ScrollView } from "react-native";
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
import { AppText as Text } from "../../components/AppText";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { useCasualVoice } from "./useCasualVoice";

const MODES: ReadonlyArray<{ mode: CasualVoiceMode; label: string; copy: string }> = [
  { mode: "local", label: "Local", copy: "Stays on this computer." },
  {
    mode: "hybrid",
    label: "Local + cloud for steers",
    copy: "Steer replies use the cloud model. Those calls leave out your style examples.",
  },
  {
    mode: "cloud",
    label: "Cloud only",
    copy: "This sends your style examples to the cloud provider.",
  },
];

export function CasualVoiceControl(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const { state, configure, allowed, backendAllowed, refresh } = useCasualVoice(
    props.environmentId,
    props.threadId,
  );
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState(false);
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
    <View className="border-b border-border bg-screen px-4">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="min-h-11 justify-center"
        onPress={() => {
          if (!open) void refresh();
          setOpen(!open);
        }}
      >
        <Text className="text-xs text-foreground-muted">
          casual voice{!state.enabled ? " off" : !ready ? ": choose model" : ""}
        </Text>
      </Pressable>
      {open ? (
        <ScrollView style={{ maxHeight: 420 }} contentContainerClassName="gap-2 pb-3">
          <SettingsSwitchRow
            icon="bubble.left.and.bubble.right"
            label="casual voice for this chat"
            value={state.enabled}
            disabled={!allowed}
            onValueChange={(enabled) => void configure({ enabled })}
          />
          <Text className="text-xs text-foreground-muted">
            {MODES.find((item) => item.mode === mode)?.copy}
          </Text>
          {MODES.map((item) => (
            <Pressable
              key={item.mode}
              accessibilityRole="button"
              accessibilityLabel="Casual voice mode"
              accessibilityState={{ selected: mode === item.mode }}
              disabled={!backendAllowed}
              className="min-h-11 justify-center"
              onPress={() => void configure({ mode: item.mode })}
            >
              <Text className="text-sm text-foreground">
                {mode === item.mode ? "✓ " : ""}
                {item.label}
              </Text>
            </Pressable>
          ))}
          {state.models.map((item) => (
            <Pressable
              key={`${item.instanceId}:${item.model}`}
              accessibilityRole="button"
              accessibilityLabel="Cloud model"
              disabled={!backendAllowed}
              className="min-h-11 justify-center"
              onPress={() => {
                const options = casualVoiceCloudOptions(item.optionDescriptors);
                void configure({
                  cloudBackend: {
                    kind: "provider",
                    styleFile: stylePath ?? "",
                    modelSelection: {
                      instanceId: ProviderInstanceId.make(item.instanceId),
                      model: item.model,
                      ...(options ? { options } : {}),
                    },
                  },
                }).then((ok) => {
                  setError(!ok);
                  if (ok) setOpen(false);
                });
              }}
            >
              <Text className="text-sm text-foreground">
                {cloud?.modelSelection.instanceId === item.instanceId &&
                cloud.modelSelection.model === item.model
                  ? "✓ "
                  : ""}
                {item.name}
              </Text>
            </Pressable>
          ))}
          {effortDescriptor
            ? effortDescriptor.options.map((option) => (
                <Pressable
                  key={option.id}
                  accessibilityRole="button"
                  accessibilityLabel="Cloud effort"
                  accessibilityState={{ selected: effort === option.id }}
                  disabled={!backendAllowed || !cloud}
                  className="min-h-11 justify-center"
                  onPress={() => {
                    if (!cloud) return;
                    const options = casualVoiceCloudOptions(
                      [effortDescriptor],
                      option.id,
                      cloud.modelSelection.options,
                    );
                    void configure({
                      cloudBackend: {
                        ...cloud,
                        modelSelection: {
                          ...cloud.modelSelection,
                          ...(options ? { options } : {}),
                        },
                      },
                    });
                  }}
                >
                  <Text className="text-sm text-foreground">
                    {effort === option.id ? "✓ " : ""}
                    {option.label}
                  </Text>
                </Pressable>
              ))
            : null}
          <SettingsSwitchRow
            icon="bubble.left.and.bubble.right"
            label="save cloud rewrites for training"
            value={state.saveTraining !== false}
            disabled={!backendAllowed}
            onValueChange={(saveTraining) => void configure({ saveTraining })}
          />
          <TextInput
            accessibilityLabel="Style file path"
            placeholder="path to STYLE.md (optional)"
            autoCapitalize="none"
            autoCorrect={false}
            value={styleFile}
            onChangeText={setStyleFile}
            className="min-h-11 rounded border border-border p-2 text-foreground"
          />
          <Pressable
            disabled={!backendAllowed || !ready}
            className="min-h-11 justify-center"
            onPress={() => {
              const patch: {
                backend?: NonNullable<typeof state.backend>;
                cloudBackend?: NonNullable<typeof state.cloudBackend>;
              } = {};
              if (state.backend) patch.backend = { ...state.backend, styleFile };
              if (state.cloudBackend) patch.cloudBackend = { ...state.cloudBackend, styleFile };
              if (patch.backend || patch.cloudBackend) void configure(patch);
            }}
          >
            <Text className="text-sm text-foreground">use local style file</Text>
          </Pressable>
          <Text className="text-xs text-foreground-muted">
            cloud steer calls leave your style examples out.
          </Text>
          <Pressable className="min-h-11 justify-center" onPress={() => setLocal(!local)}>
            <Text className="text-sm text-foreground">local endpoint</Text>
          </Pressable>
          {local ? (
            <View className="gap-2">
              <TextInput
                accessibilityLabel="Endpoint URL"
                placeholder="endpoint URL, including /v1/"
                autoCapitalize="none"
                autoCorrect={false}
                value={url}
                onChangeText={setUrl}
                className="min-h-11 rounded border border-border p-2 text-foreground"
              />
              <TextInput
                accessibilityLabel="Endpoint model id"
                placeholder="model id"
                autoCapitalize="none"
                autoCorrect={false}
                value={model}
                onChangeText={setModel}
                className="min-h-11 rounded border border-border p-2 text-foreground"
              />
              {state.backend?.kind === "local" ? (
                <Text className="text-xs text-foreground-muted">
                  using {state.backend.model} at {state.backend.url}
                </Text>
              ) : null}
              <Pressable
                disabled={!backendAllowed || !url || !model}
                className="min-h-11 justify-center"
                onPress={() =>
                  void configure({
                    backend: {
                      kind: "local",
                      url,
                      model,
                      styleFile: stylePath ?? "",
                    },
                    ...(state.backend?.kind === "provider" &&
                    state.cloudBackend?.kind !== "provider"
                      ? { cloudBackend: state.backend }
                      : {}),
                  }).then((ok) => {
                    setError(!ok);
                    if (ok) setOpen(false);
                  })
                }
              >
                <Text className="text-sm text-foreground">use endpoint</Text>
              </Pressable>
            </View>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" className="text-xs text-foreground">
              couldn’t save. try again.
            </Text>
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  );
}
