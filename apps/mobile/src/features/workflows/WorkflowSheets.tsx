import { useReducedMotion } from "react-native-reanimated";
import type {
  EnvironmentId,
  ModelSelection,
  WorkflowAgentNode,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeId,
} from "@t3tools/contracts";
import { useMemo, useState, type ReactNode } from "react";
import { getExplicitModelEffortLabel } from "@t3tools/shared/model";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../state/entities";
import { ModelRow } from "../threads/ThreadSettingsRows";

export function WorkflowButton({
  title,
  onPress,
  disabled,
  danger = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      className="min-h-11 justify-center rounded-xl bg-secondary px-4 disabled:opacity-40"
    >
      <Text
        className={
          danger
            ? "text-sm font-t3-medium text-danger-foreground"
            : "text-sm font-t3-medium text-primary"
        }
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function WorkflowSheet({
  title,
  children,
  onClose,
  footer,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <Modal
      visible
      animationType={reducedMotion ? "none" : "slide"}
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-sheet-solid pt-4">
        <View className="flex-row items-center justify-between px-5 pb-3">
          <Text accessibilityRole="header" className="text-lg font-t3-semibold">
            {title}
          </Text>
          <WorkflowButton title="Close" onPress={onClose} />
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          contentContainerClassName="gap-4 p-5 pb-12"
        >
          {children}
          {footer}
        </ScrollView>
      </View>
    </Modal>
  );
}

export function WorkflowField({
  label,
  value,
  onChange,
  multiline = false,
  maxLength = 4000,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  multiline?: boolean;
  maxLength?: number;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-t3-medium">{label}</Text>
      <AppTextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        maxLength={maxLength}
        style={multiline ? { minHeight: 100, textAlignVertical: "top" } : undefined}
      />
    </View>
  );
}

export function WorkflowChoice({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: string;
  choices: readonly { id: string; title: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text className="flex-1 text-sm">{label}</Text>
      <ControlPillMenu
        title={label}
        actions={choices.map((choice) => ({
          ...choice,
          state: choice.id === value ? "on" : "off",
        }))}
        onPressAction={({ nativeEvent }) => onChange(nativeEvent.event)}
      >
        <ControlPill
          variant="pill"
          label={choices.find((choice) => choice.id === value)?.title ?? value}
          icon="chevron.down"
        />
      </ControlPillMenu>
    </View>
  );
}

export function WorkflowModelPicker({
  environmentId,
  selection,
  onSelect,
  onClose,
}: {
  environmentId: EnvironmentId;
  selection: ModelSelection | null;
  onSelect: (selection: ModelSelection) => void;
  onClose: () => void;
}) {
  const config = useEnvironmentServerConfig(environmentId);
  const [search, setSearch] = useState("");
  const groups = useMemo(
    () =>
      groupByProvider(
        buildModelOptions(config, selection, undefined, null).filter(
          (option) =>
            !option.isHidden &&
            `${option.label} ${option.subtitle}`.toLowerCase().includes(search.toLowerCase()),
        ),
      ),
    [config, search, selection],
  );
  return (
    <WorkflowSheet title="Choose model" onClose={onClose}>
      <AppTextInput
        accessibilityLabel="Search models"
        placeholder="Search models"
        value={search}
        onChangeText={setSearch}
      />
      {groups.length === 0 ? (
        <Text className="text-foreground-muted">
          No models available. Check this environment's providers.
        </Text>
      ) : (
        groups.map((group) => (
          <View key={group.providerKey} className="gap-2">
            <Text className="text-sm text-foreground-muted">{group.providerLabel}</Text>
            {group.models.map((option, index) => (
              <ModelRow
                key={option.key}
                option={option}
                selected={
                  option.selection.instanceId === selection?.instanceId &&
                  option.selection.model === selection.model
                }
                onPress={() => {
                  onSelect(option.selection);
                  onClose();
                }}
                isFavorite={false}
                favoritesLoaded={false}
                onToggleFavorite={() => {}}
                isFirst={index === 0}
                isLast={index === group.models.length - 1}
              />
            ))}
          </View>
        ))
      )}
    </WorkflowSheet>
  );
}

export function WorkflowNodeSheet({
  node,
  workflow,
  environmentId,
  onSave,
  onClose,
}: {
  node: WorkflowNode;
  workflow: WorkflowDefinition;
  environmentId: EnvironmentId;
  onSave: (node: WorkflowNode, after: WorkflowNodeId | null | undefined) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(node);
  const [modelOpen, setModelOpen] = useState(false);
  const [count, setCount] = useState(
    node.kind === "agent"
      ? String(node.count.kind === "exact" ? node.count.n : node.count.max)
      : "1",
  );
  const [dependencyChanged, setDependencyChanged] = useState(false);
  const [after, setAfter] = useState<WorkflowNodeId | null>(
    workflow.edges.find((edge) => edge.kind === "then" && edge.to === node.id)?.from ?? null,
  );
  const parent = workflow.edges.find(
    (edge) => edge.kind === "delegates" && edge.to === node.id,
  )?.from;
  const siblings = workflow.edges
    .filter((edge) => edge.kind === "delegates" && edge.from === parent && edge.to !== node.id)
    .flatMap((edge) =>
      workflow.nodes.filter((entry) => entry.id === edge.to && entry.kind === "agent"),
    );
  const update = (patch: Partial<WorkflowAgentNode>) =>
    setDraft((current) => (current.kind === "agent" ? { ...current, ...patch } : current));
  const validCount = /^\d+$/u.test(count) && Number(count) >= 1 && Number(count) <= 16;
  return (
    <>
      <WorkflowSheet
        title={draft.kind === "agent" ? "Edit agent" : "Edit note"}
        onClose={onClose}
        footer={
          <WorkflowButton
            title="Done"
            disabled={draft.kind === "agent" && !validCount}
            onPress={() => {
              const updated =
                draft.kind === "agent"
                  ? {
                      ...draft,
                      count:
                        draft.count.kind === "exact"
                          ? { kind: "exact" as const, n: Number(count) }
                          : { kind: "upTo" as const, max: Number(count) },
                    }
                  : draft;
              onSave(updated, dependencyChanged ? after : undefined);
              onClose();
            }}
          />
        }
      >
        {draft.kind === "agent" ? (
          <>
            <WorkflowField
              label="Label"
              value={draft.label}
              onChange={(label) => update({ label })}
              maxLength={80}
            />
            <WorkflowField
              label="Drawing text"
              value={draft.text}
              onChange={(text) => update({ text })}
              maxLength={2000}
            />
            <WorkflowButton
              title={[
                draft.model?.model ?? "Choose model",
                getExplicitModelEffortLabel(draft.model),
              ]
                .filter(Boolean)
                .join(" · ")}
              onPress={() => setModelOpen(true)}
            />
            <WorkflowField
              label="Brief"
              value={draft.instructions}
              onChange={(instructions) => update({ instructions })}
              multiline
            />
            <WorkflowChoice
              label="Count"
              value={draft.count.kind}
              choices={[
                { id: "exact", title: "Exactly" },
                { id: "upTo", title: "Up to (many)" },
              ]}
              onChange={(kind) =>
                update({
                  count:
                    kind === "exact"
                      ? { kind: "exact", n: Number(count) || 1 }
                      : { kind: "upTo", max: Number(count) || 1 },
                })
              }
            />
            <WorkflowField label="Agents (1–16)" value={count} onChange={setCount} maxLength={2} />
            {!validCount ? (
              <Text className="text-danger-foreground">Choose a count from 1 to 16.</Text>
            ) : null}
            <WorkflowChoice
              label="Color"
              value={draft.color ?? "default"}
              choices={[
                { id: "default", title: "Default" },
                { id: "violet", title: "Violet" },
                { id: "blue", title: "Blue" },
                { id: "green", title: "Green" },
                { id: "amber", title: "Amber" },
                { id: "rose", title: "Rose" },
              ]}
              onChange={(color) => update({ color })}
            />
            <WorkflowChoice
              label="Workspace"
              value={draft.isolation}
              choices={[
                { id: "shared", title: "Shared" },
                { id: "worktree", title: "Worktree" },
              ]}
              onChange={(isolation) =>
                update({ isolation: isolation === "worktree" ? "worktree" : "shared" })
              }
            />
            {siblings.length ? (
              <WorkflowChoice
                label="Start after"
                value={after ?? "none"}
                choices={[
                  { id: "none", title: "No dependency" },
                  ...siblings.map((entry) => ({
                    id: entry.id,
                    title: entry.kind === "agent" ? entry.label : "Note",
                  })),
                ]}
                onChange={(id) => {
                  setDependencyChanged(true);
                  setAfter(
                    id === "none" ? null : (siblings.find((entry) => entry.id === id)?.id ?? null),
                  );
                }}
              />
            ) : null}
          </>
        ) : (
          <>
            <WorkflowField
              label="Note"
              value={draft.text}
              onChange={(text) => setDraft({ ...draft, text })}
              multiline
            />
            <WorkflowChoice
              label="Attach to"
              value={draft.attachedTo ?? "none"}
              choices={[
                { id: "none", title: "Whole run" },
                ...workflow.nodes
                  .filter((entry) => entry.kind === "agent")
                  .map((entry) => ({
                    id: entry.id,
                    title: entry.kind === "agent" ? entry.label : "",
                  })),
              ]}
              onChange={(id) =>
                setDraft({
                  ...draft,
                  attachedTo: workflow.nodes.find((entry) => entry.id === id)?.id ?? null,
                })
              }
            />
          </>
        )}
      </WorkflowSheet>
      {modelOpen ? (
        <WorkflowModelPicker
          environmentId={environmentId}
          selection={draft.kind === "agent" ? draft.model : null}
          onSelect={(model) => update({ model })}
          onClose={() => setModelOpen(false)}
        />
      ) : null}
    </>
  );
}
