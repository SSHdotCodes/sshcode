import {
  modelRankingRunEvidence,
  modelRankingUsedFamilies,
  modelRankingRunDetails,
} from "@t3tools/client-runtime/state/subagent-rankings";
import type { SubagentRankingsSnapshot } from "@t3tools/contracts";
import { uuidv4 } from "../../lib/uuid";
import { useMemo, useRef, useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue } from "@effect/atom-react";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ModelRankingTier,
  type ModelRankings,
  type ModelRankingCategory,
} from "@t3tools/contracts";
import {
  BUILT_IN_MODEL_RANKING_CATEGORIES,
  emptyModelRankingCategory,
  modelRankingCategories,
  modelRankingCatalog,
  modelRankingRows,
  positionModelRankingEntry,
  rankedEntryTier,
  type ModelRankingRow,
  migrateModelRankings,
  orderedModelRankingEntries,
  replaceModelRankingCategory,
  resetModelRankingCategory,
  updateModelRankingEntry,
} from "@t3tools/shared/modelRankings";
import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { subagentRankingsEnvironment, modelRankingsEnvironment } from "../../state/server";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

import { ModelRankingNoteDraft as TextDraft } from "@t3tools/client-runtime/model-rankings";

function ModelRankingNoteField({
  value,
  initialText,
  label,
  disabled,
  className,
  onSave,
}: {
  value: string;
  initialText: string;
  label: string;
  disabled: boolean;
  className: string;
  onSave: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(() => TextDraft.change(TextDraft.create(value), initialText));
  const current = TextDraft.receive(draft, value);
  if (draft.source !== value) setDraft(current);
  const latestText = useRef<{ source: string; text: string } | null>(null);
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const commit = async () => {
    if (disabled || inFlight.current) return;
    // Blur/end-editing payloads can lag the last change on native inputs.
    const latest =
      latestText.current?.source === current.source
        ? TextDraft.change(current, latestText.current.text)
        : current;
    const submitted = TextDraft.commitValue(latest);
    if (submitted === null) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      if (await onSave(submitted)) {
        setDraft((previous) => TextDraft.acknowledge(previous, submitted));
        if (latestText.current?.text.trim() === submitted) latestText.current = null;
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };
  return (
    <View className="gap-2">
      <TextInput
        accessibilityLabel={label}
        value={current.text}
        maxLength={500}
        editable={!disabled && !submitting}
        multiline
        textAlignVertical="top"
        numberOfLines={2}
        placeholder="What works well for this task? Agents receive a short excerpt."
        placeholderTextColorClassName="accent-placeholder"
        className={className}
        onChangeText={(text) => {
          latestText.current = { source: value, text };
          setDraft((previous) => TextDraft.change(TextDraft.receive(previous, value), text));
        }}
        onBlur={() => void commit()}
        onEndEditing={() => void commit()}
      />
      <ControlPill
        label="Save note"
        variant="pill"
        disabled={disabled || submitting || TextDraft.commitValue(current) === null}
        onPress={() => void commit()}
      />
    </View>
  );
}

const TIER_COLORS: Record<ModelRankingTier, string> = {
  S: "bg-danger",
  A: "bg-warning",
  B: "bg-adaptive-amber-500-a25-400-a25",
  C: "bg-adaptive-emerald-500-a12-a16",
  D: "bg-adaptive-sky-500-a12-a16",
  F: "bg-adaptive-violet-500-a12-a16",
};
const TIER_TEXT_COLORS: Record<ModelRankingTier, string> = {
  S: "text-danger-foreground",
  A: "text-warning-foreground",
  B: "text-adaptive-amber-800-200",
  C: "text-adaptive-emerald-700-300",
  D: "text-adaptive-sky-700-300",
  F: "text-adaptive-violet-700-300",
};

function RankingChip({
  row,
  evidence,
  disabled,
  lastIndex,
  onPosition,
  onEditNote,
}: {
  row: ModelRankingRow;
  evidence: SubagentRankingsSnapshot["models"];
  disabled: boolean;
  lastIndex: number;
  onPosition: (tier: ModelRankingTier | null, index?: number) => void;
  onEditNote: (() => void) | undefined;
}) {
  const { entry, provider, tier, tierIndex } = row;
  const chip = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${entry.label}, ${row.modelLabel ?? "unavailable"}, ${tier ? `tier ${tier}` : "unranked"}. Options`}
      disabled={disabled}
      className={`max-w-full flex-row items-center gap-2 rounded-xl border border-border-subtle bg-grouped-card px-3 py-2.5 ${tier === null ? "opacity-60" : ""}`}
    >
      {provider ? (
        <ProviderIcon provider={provider.driver} iconUrl={provider.iconUrl} size={18} />
      ) : null}
      <View className="min-w-0 shrink">
        <Text numberOfLines={1} className="text-sm font-t3-medium">
          {entry.label}
        </Text>
        <Text numberOfLines={1} className="text-xs text-foreground-muted">
          {row.modelLabel ?? "Unavailable"}
        </Text>
      </View>
    </Pressable>
  );
  const menu = disabled ? (
    chip
  ) : (
    <ControlPillMenu
      style={{ maxWidth: "100%" }}
      accessibilityLabel={`Options for ${entry.label}`}
      actions={[
        ...ModelRankingTier.literals.map((destination) => ({
          id: destination,
          title: `Move to ${destination}`,
          attributes: { disabled: tier === destination },
        })),
        { id: "unrank", title: "Unranked", attributes: { disabled: tier === null } },
        {
          id: "earlier",
          title: "Move earlier",
          attributes: { disabled: tierIndex === null || tierIndex === 0 },
        },
        {
          id: "later",
          title: "Move later",
          attributes: { disabled: tierIndex === null || tierIndex === lastIndex },
        },
        ...(onEditNote ? [{ id: "note", title: "Edit note" }] : []),
      ]}
      onPressAction={({ nativeEvent }) => {
        const action = nativeEvent.event;
        const destination = ModelRankingTier.literals.find((value) => value === action);
        if (destination) onPosition(destination);
        else if (action === "unrank") onPosition(null);
        else if (action === "earlier" && tierIndex !== null) onPosition(tier, tierIndex - 1);
        else if (action === "later" && tierIndex !== null) onPosition(tier, tierIndex + 1);
        else if (action === "note") onEditNote?.();
      }}
    >
      {chip}
    </ControlPillMenu>
  );
  return (
    <View className="max-w-full gap-1">
      {menu}
      {evidence.length > 1 ? (
        <Text className="px-2 text-xs text-foreground-muted">From your runs</Text>
      ) : null}
      {evidence.map((model) => (
        <Pressable
          key={`${model.instanceId}:${model.model}`}
          accessibilityRole="button"
          accessibilityHint="Show model results by task kind"
          onPress={() => Alert.alert("From your runs", modelRankingRunDetails([model]))}
          className="min-h-11 justify-center px-2"
        >
          <Text className="text-xs text-foreground-muted">
            {evidence.length === 1
              ? `From your runs · ${model.model}: `
              : `${model.model} · ${model.instanceId}: `}
            {model.yourRuns}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function SettingsModelRankingsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Model family rankings" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <Text className="px-2 text-sm text-foreground-muted">
            Choose your preferred families for each task. New releases inherit their family’s rank.
          </Text>
          {!selectedTargets.length ? (
            <Text className="px-2 text-base text-foreground-muted">
              Select a connected environment.
            </Text>
          ) : (
            selectedTargets.map((environment) => (
              <EnvironmentRankings key={environment.environmentId} environment={environment} />
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentRankings({ environment }: { environment: SettingsTarget }) {
  if (environment.serverConfig.modelFamilyRankings !== true)
    return (
      <SettingsSection title={environment.label}>
        <Text className="p-4 text-sm text-foreground-muted">
          Update this environment to save model family rankings safely across clients.
        </Text>
      </SettingsSection>
    );
  return <RankingsEditor environment={environment} />;
}

function RankingsEditor({ environment }: { environment: SettingsTarget }) {
  const {
    rankings: savedRankings,
    baseRankings,
    saving,
    error,
    canWrite,
    settings,
    unsaved,
    conflict,
    draftVersion,
  } = useAtomValue(modelRankingsEnvironment.stateAtom(environment.environmentId));
  const evidence = useAtomValue(
    subagentRankingsEnvironment.snapshotAtom(environment.environmentId),
  );
  const providers = environment.serverConfig.providers;
  const rankings = migrateModelRankings(savedRankings, settings?.providerInstances, providers);
  const saveCommand = useAtomCommand(modelRankingsEnvironment.save);
  const save = (input: ModelRankings) =>
    saveCommand({
      environmentId: environment.environmentId,
      input,
      expectedModelRankings: baseRankings,
    });
  const discardCommand = useAtomCommand(modelRankingsEnvironment.discard);
  const [categoryId, setCategoryId] = useState("implementation");
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [noteId, setNoteId] = useState<string | null>(null);
  const categories = modelRankingCategories(rankings);
  const category = categories.find((item) => item.id === categoryId) ?? categories[0]!;
  const catalog = useMemo(
    () => (settings ? modelRankingCatalog(settings, providers) : []),
    [settings, providers],
  );
  const used = useMemo(() => modelRankingUsedFamilies(evidence?.models), [evidence]);
  const rows = modelRankingRows(category, catalog, providers, showAll, used);
  const ordered = orderedModelRankingEntries(category);
  const disabled = !canWrite || saving || !settings;
  const update = (next: ModelRankingCategory) =>
    void save(replaceModelRankingCategory(rankings, next));
  const position = (row: ModelRankingRow, tier: ModelRankingTier | null, index?: number) =>
    update(positionModelRankingEntry(category, row.entry, tier, index));
  const noteRow = rows.find((row) => row.entry.id === noteId);
  const inputClass =
    "rounded-2xl border border-border-subtle bg-grouped-card px-4 py-3 text-base text-foreground";

  function renderChips(tier: ModelRankingTier | null) {
    return rows
      .filter((row) => row.tier === tier)
      .map((row) => (
        <RankingChip
          key={row.entry.id}
          row={row}
          evidence={modelRankingRunEvidence(row.entry, evidence?.models ?? [])}
          disabled={
            disabled ||
            (!category.entries.some((entry) => entry.id === row.entry.id) &&
              category.entries.length >= 100)
          }
          lastIndex={
            ordered.filter((entry) => rankedEntryTier(category, entry) === tier).length - 1
          }
          onPosition={(destination, index) => position(row, destination, index)}
          onEditNote={
            category.entries.some((entry) => entry.id === row.entry.id)
              ? () => setNoteId(noteId === row.entry.id ? null : row.entry.id)
              : undefined
          }
        />
      ));
  }

  return (
    <View className="gap-5">
      <SettingsSection title={environment.label}>
        <View className="gap-3 p-4">
          {!canWrite ? (
            <Text className="text-sm text-foreground-muted">
              Settings access is required to edit rankings.
            </Text>
          ) : null}
          <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
            {saving ? "Saving…" : "Changes save automatically."}
          </Text>
          {error ? (
            <Text accessibilityRole="alert" className="text-sm text-danger">
              {error}
            </Text>
          ) : null}
          {unsaved ? (
            <View className="flex-row flex-wrap gap-2">
              <ControlPill
                label="Retry saving"
                variant="pill"
                disabled={disabled || conflict}
                onPress={() => void save(rankings)}
              />
              <ControlPill
                label="Discard unsaved changes"
                variant="pill"
                disabled={saving}
                onPress={() => void discardCommand({ environmentId: environment.environmentId })}
              />
            </View>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            {categories.map((item) => (
              <ControlPill
                key={item.id}
                label={item.name}
                variant={item.id === category.id ? "primary" : "pill"}
                onPress={() => {
                  setCategoryId(item.id);
                  setNoteId(null);
                }}
              />
            ))}
            <ControlPill
              icon="plus"
              accessibilityLabel="Add category"
              disabled={disabled || categories.length >= 30}
              onPress={() => setAddingCategory(!addingCategory)}
            />
          </View>
          {addingCategory ? (
            <View className="gap-2">
              <TextInput
                accessibilityLabel="New task category"
                placeholder="Category name"
                placeholderTextColorClassName="accent-placeholder"
                className={inputClass}
                maxLength={80}
                value={newCategory}
                editable={!disabled}
                onChangeText={setNewCategory}
              />
              <ControlPill
                label="Add category"
                variant="pill"
                disabled={disabled || !newCategory.trim() || categories.length >= 30}
                onPress={() => {
                  const next = emptyModelRankingCategory(uuidv4(), newCategory.trim());
                  update(next);
                  setCategoryId(next.id);
                  setNewCategory("");
                  setAddingCategory(false);
                }}
              />
            </View>
          ) : null}
        </View>
      </SettingsSection>
      <SettingsSection title={`Preferred for ${category.name.toLowerCase()}`}>
        <View className="gap-3 p-4">
          <Text className="text-sm text-foreground-muted">
            Agents pick subagents from the highest tier. A model you name in chat always wins.
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <ControlPill
              label="Reset"
              variant="pill"
              disabled={disabled || !ordered.length}
              onPress={() => update(resetModelRankingCategory(category))}
            />
            {!BUILT_IN_MODEL_RANKING_CATEGORIES.some((item) => item.id === category.id) ? (
              <ControlPill
                label="Delete category"
                variant="pill"
                disabled={disabled}
                onPress={() => {
                  void save(rankings.filter((item) => item.id !== category.id));
                  setCategoryId("implementation");
                }}
              />
            ) : null}
          </View>
          {!ordered.length && rows.length ? (
            <Text className="text-xs text-foreground-muted">
              Tap a family to move it into a tier. Earlier comes first within each tier.
            </Text>
          ) : null}
          <View className="overflow-hidden rounded-2xl border border-border-subtle">
            {ModelRankingTier.literals.map((tier) => (
              <View
                key={tier}
                accessibilityLabel={`Tier ${tier}`}
                className={`min-h-16 flex-row ${tier === "F" ? "" : "border-b border-border-subtle"}`}
              >
                <View className={`w-10 items-center justify-center ${TIER_COLORS[tier]}`}>
                  <Text className={`text-lg font-t3-bold ${TIER_TEXT_COLORS[tier]}`}>{tier}</Text>
                </View>
                <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-2 p-2">
                  {renderChips(tier)}
                </View>
              </View>
            ))}
          </View>
          <View
            accessibilityLabel="Unranked"
            className="gap-2 rounded-2xl border border-dashed border-border-subtle p-3"
          >
            <Text className="text-xs text-foreground-muted">Unranked</Text>
            <View className="flex-row flex-wrap gap-2">{renderChips(null)}</View>
          </View>
          {noteRow ? (
            <View className="gap-2">
              <Text className="text-xs text-foreground-muted">Note for {noteRow.entry.label}</Text>
              <ModelRankingNoteField
                key={`${category.id}:${noteRow.entry.id}:${draftVersion}`}
                label={`Note for ${noteRow.entry.label}`}
                initialText={noteRow.entry.note ?? ""}
                value={
                  baseRankings
                    .find((saved) => saved.id === category.id)
                    ?.entries.find((saved) => saved.id === noteRow.entry.id)?.note ?? ""
                }
                className={inputClass}
                disabled={disabled}
                onSave={async (note) => {
                  const { note: _note, ...rest } = noteRow.entry;
                  const next = updateModelRankingEntry(
                    category,
                    note ? { ...noteRow.entry, note } : rest,
                  );
                  const result = await save(replaceModelRankingCategory(rankings, next));
                  return (
                    result._tag === "Success" &&
                    (result.value.modelRankings
                      .find((saved) => saved.id === category.id)
                      ?.entries.find((saved) => saved.id === noteRow.entry.id)?.note ?? "") === note
                  );
                }}
              />
            </View>
          ) : null}
          {!rows.length ? (
            <Text className="py-3 text-sm text-foreground-muted">
              No usable families available. Enable a provider in this environment, or show all
              families.
            </Text>
          ) : null}
          <ControlPill
            label={showAll ? "Show usable families only" : "Show all families"}
            variant="pill"
            onPress={() => setShowAll(!showAll)}
          />
        </View>
      </SettingsSection>
    </View>
  );
}
