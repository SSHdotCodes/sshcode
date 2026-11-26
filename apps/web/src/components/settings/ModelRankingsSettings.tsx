import {
  modelRankingRunEvidence,
  modelRankingUsedFamilies,
  modelRankingRunDetails,
} from "@t3tools/client-runtime/state/subagent-rankings";
import type { SubagentRankingsSnapshot } from "@t3tools/contracts";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, rectSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { ModelRankingNoteDraft as TextDraft } from "@t3tools/client-runtime/model-rankings";
import {
  ModelRankingTier,
  type EnvironmentId,
  type ModelRankings,
  type ModelRankingCategory,
} from "@t3tools/contracts";
import {
  BUILT_IN_MODEL_RANKING_CATEGORIES,
  emptyModelRankingCategory,
  modelRankingCategories,
  modelRankingCatalog,
  modelRankingRows,
  migrateModelRankings,
  orderedModelRankingEntries,
  positionModelRankingEntry,
  rankedEntryTier,
  replaceModelRankingCategory,
  resetModelRankingCategory,
  updateModelRankingEntry,
  type ModelRankingRow,
} from "@t3tools/shared/modelRankings";
import { randomUUID, cn } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { subagentRankingsEnvironment, modelRankingsEnvironment } from "../../state/server";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Link } from "@tanstack/react-router";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";

export function ModelRankingsSettings() {
  const { environment } = useSettingsScope();
  if (!environment?.serverConfig)
    return (
      <SettingsPageContainer>
        Connect an environment to edit model family rankings.
      </SettingsPageContainer>
    );
  if (environment.serverConfig.modelFamilyRankings !== true)
    return (
      <SettingsPageContainer>
        Update this environment to save model family rankings safely across clients.
      </SettingsPageContainer>
    );
  return (
    <ModelRankingsEditor
      key={environment.environmentId}
      environmentId={environment.environmentId}
      providers={environment.serverConfig.providers}
    />
  );
}

/** Settings' grading switch: off removes grading from agents' rules and tools. */
function SubagentGradingRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("subagent-grading")}
      description="Leads flag subagent work that fell short, 1 to 6 with a reason; work they don't flag counts as fine. Flags show on the subagent's card and feed these rankings. Off removes grading from agents, so it costs no tokens."
      settingKeys={["subagentGrading"]}
      control={
        <ScopedSwitch
          settingKeys={["subagentGrading"]}
          checked={settings.subagentGrading}
          onCheckedChange={(checked) => updateSettings({ subagentGrading: Boolean(checked) })}
          aria-label="Grade subagents"
        />
      }
    />
  );
}

function ModelRankingsEditor({
  environmentId,
  providers,
}: {
  environmentId: EnvironmentId;
  providers: Parameters<typeof modelRankingCatalog>[1];
}) {
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
  } = useAtomValue(modelRankingsEnvironment.stateAtom(environmentId));
  const evidence = useAtomValue(subagentRankingsEnvironment.snapshotAtom(environmentId));
  const rankings = migrateModelRankings(savedRankings, settings?.providerInstances, providers);
  const saveCommand = useAtomCommand(modelRankingsEnvironment.save);
  const save = (input: ModelRankings) =>
    saveCommand({ environmentId, input, expectedModelRankings: baseRankings });
  const discardCommand = useAtomCommand(modelRankingsEnvironment.discard);
  const categories = modelRankingCategories(rankings);
  const [categoryId, setCategoryId] = useState("implementation");
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [noteId, setNoteId] = useState<string | null>(null);
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
  const sensors = useSensors(useSensor(PointerSensor));

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
    <SettingsPageContainer className="gap-4">
      <div id="model-rankings" className="space-y-2 px-3 sm:px-4">
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
          Agents pick subagents from the highest tier. A model you name in chat always wins.{" "}
          <span role="status" aria-live="polite">
            {saving ? "Saving…" : "Changes save automatically."}
          </span>
        </p>
        {!canWrite ? (
          <p className="text-xs text-muted-foreground">
            Settings access is required to edit rankings.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {unsaved ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || conflict}
              onClick={() => void save(rankings)}
            >
              Retry saving
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => void discardCommand({ environmentId })}
            >
              Discard unsaved changes
            </Button>
          </div>
        ) : null}
      </div>
      <SettingsSection title="Subagent grading" hideTitle>
        <SubagentGradingRow />
      </SettingsSection>
      <SettingsSection title="Task category" hideTitle variant="plain">
        <div className="flex flex-wrap gap-1.5 px-3 sm:px-4">
          {categories.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={item.id === category.id ? "outline" : "ghost-muted"}
              aria-pressed={item.id === category.id}
              onClick={() => {
                setCategoryId(item.id);
                setNoteId(null);
              }}
            >
              {item.name}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost-muted"
            aria-expanded={addingCategory}
            disabled={disabled || categories.length >= 30}
            onClick={() => setAddingCategory(!addingCategory)}
          >
            <PlusIcon className="size-3.5" />
            Add category
          </Button>
        </div>
        {addingCategory ? (
          <form
            className="mt-3 flex max-w-md gap-2 px-3 sm:px-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!newCategory.trim() || categories.length >= 30 || disabled) return;
              const next = emptyModelRankingCategory(randomUUID(), newCategory.trim());
              update(next);
              setCategoryId(next.id);
              setNewCategory("");
              setAddingCategory(false);
            }}
          >
            <Input
              size="sm"
              aria-label="New task category"
              placeholder="Category name"
              maxLength={80}
              value={newCategory}
              disabled={disabled}
              onChange={(event) => setNewCategory(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={disabled || !newCategory.trim()}
            >
              Add
            </Button>
          </form>
        ) : null}
      </SettingsSection>
      <SettingsSection
        title={`Preferred for ${category.name.toLowerCase()}`}
        variant="plain"
        headerAction={
          <div className="flex gap-1">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled || !ordered.length}
              onClick={() => update(resetModelRankingCategory(category))}
            >
              Reset
            </Button>
            {!BUILT_IN_MODEL_RANKING_CATEGORIES.some((item) => item.id === category.id) ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={disabled}
                onClick={() => {
                  void save(rankings.filter((item) => item.id !== category.id));
                  setCategoryId("implementation");
                }}
              >
                Delete category
              </Button>
            ) : null}
          </div>
        }
      >
        {!ordered.length && rows.length ? (
          <p className="px-3 text-xs text-muted-foreground sm:px-4">
            Drag families into a tier, or use their menus. Left comes first within each tier.
          </p>
        ) : null}
        <DndContext
          key={category.id}
          sensors={sensors}
          accessibility={{
            screenReaderInstructions: {
              draggable: "Use the family options menu to choose a tier or move left and right.",
            },
          }}
          collisionDetection={(args) => {
            const hits = pointerWithin(args);
            return hits.length ? hits : rectIntersection(args);
          }}
          onDragEnd={({ active, over }) => {
            if (disabled || !over || active.id === over.id) return;
            const row = rows.find((item) => chipId(item.entry.id) === active.id);
            const target = rows.find((item) => chipId(item.entry.id) === over.id);
            const tier = ModelRankingTier.literals.find((value) => tierId(value) === over.id);
            if (!row || (!target && tier === undefined && over.id !== tierId(null))) return;
            position(row, target ? target.tier : (tier ?? null), target?.tierIndex ?? undefined);
          }}
        >
          <div
            className="rounded-xl border border-border/60 bg-card/45 shadow-xs/5"
            aria-label={`${category.name} tier list`}
          >
            {ModelRankingTier.literals.map((tier) => (
              <RankingTier key={tier} tier={tier} rows={rows}>
                {renderChips(tier)}
              </RankingTier>
            ))}
          </div>
          <div className="mt-3 rounded-xl border border-dashed border-border/80">
            <RankingTier tier={null} rows={rows}>
              {renderChips(null)}
            </RankingTier>
          </div>
        </DndContext>
        {noteRow ? (
          <div className="mt-4 max-w-lg px-3 sm:px-4">
            <p className="mb-2 text-xs text-muted-foreground">Note for {noteRow.entry.label}</p>
            <ModelRankingNoteField
              key={`${category.id}:${noteRow.entry.id}:${draftVersion}`}
              label={`Note for ${noteRow.entry.label}`}
              initialText={noteRow.entry.note ?? ""}
              value={
                baseRankings
                  .find((saved) => saved.id === category.id)
                  ?.entries.find((saved) => saved.id === noteRow.entry.id)?.note ?? ""
              }
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
          </div>
        ) : null}
        {!rows.length ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 pt-3 sm:px-4">
            <p className="text-xs text-muted-foreground">
              No usable families yet. Turn on a provider to rank its models, or show all families.
            </p>
            <Button size="xs" variant="outline" render={<Link to="/settings/providers" />}>
              Open Providers
            </Button>
          </div>
        ) : null}
        <div className="px-3 pt-3 sm:px-4">
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(event) => setShowAll(event.target.checked)}
            />
            Show all families
          </label>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

const TIER_COLORS: Record<ModelRankingTier, string> = {
  S: "bg-red-100 text-red-900 dark:bg-red-400/15 dark:text-red-200",
  A: "bg-orange-100 text-orange-900 dark:bg-orange-400/15 dark:text-orange-200",
  B: "bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200",
  C: "bg-green-100 text-green-900 dark:bg-green-400/15 dark:text-green-200",
  D: "bg-blue-100 text-blue-900 dark:bg-blue-400/15 dark:text-blue-200",
  F: "bg-slate-100 text-slate-900 dark:bg-slate-400/15 dark:text-slate-200",
};
const tierId = (tier: ModelRankingTier | null) => `tier:${tier ?? "unranked"}`;
const chipId = (id: string) => `family:${id}`;

function RankingTier({
  tier,
  rows,
  children,
}: {
  tier: ModelRankingTier | null;
  rows: ReadonlyArray<ModelRankingRow>;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: tierId(tier) });
  return (
    <section
      ref={setNodeRef}
      aria-label={tier ? `Tier ${tier}` : "Unranked"}
      className={cn(
        "flex min-h-12 first:rounded-t-xl last:rounded-b-xl",
        tier && "border-b border-border/50 last:border-b-0",
        "transition-colors duration-120 motion-reduce:transition-none",
        isOver && "bg-accent/50",
      )}
    >
      <h3
        className={cn(
          "flex w-12 shrink-0 items-center justify-center self-stretch text-sm font-semibold sm:w-14",
          tier ? TIER_COLORS[tier] : "w-20 px-2 text-xs font-medium text-muted-foreground sm:w-20",
          tier === "S" && "rounded-tl-xl",
          tier === "F" && "rounded-bl-xl",
        )}
      >
        {tier ?? "Unranked"}
      </h3>
      <SortableContext
        items={rows.filter((row) => row.tier === tier).map((row) => chipId(row.entry.id))}
        strategy={rectSortingStrategy}
      >
        {/* Equal columns: chips with run evidence are tall, so a free wrap left ragged gaps. */}
        <ul className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] content-center items-start gap-2 p-2">
          {children}
        </ul>
      </SortableContext>
    </section>
  );
}

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
  const { entry, tier, tierIndex, provider } = row;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useSortable({ id: chipId(entry.id), disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        "flex max-w-full items-center rounded-md border border-border bg-background p-1 shadow-xs",
        tier === null && "opacity-60",
        isDragging && "relative z-40 opacity-90 shadow-md",
      )}
      aria-description={row.unavailableReason ?? undefined}
    >
      <div className="min-w-0 flex-1">
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          disabled={disabled}
          aria-label={`Drag ${entry.label}`}
          className="flex min-w-0 touch-none items-center gap-2 rounded px-1.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring enabled:cursor-grab disabled:opacity-50"
        >
          <GripVerticalIcon className="size-3 shrink-0 text-muted-foreground" />
          {provider ? (
            <ProviderInstanceIcon
              driverKind={provider.driver}
              displayName={provider.displayName ?? entry.label}
              acpRegistryIconUrl={provider.iconUrl}
              showBadge={false}
              iconClassName="size-4"
            />
          ) : null}
          <span className="max-w-64 truncate">
            <span className="font-medium">{entry.label}</span>
            <span className="text-xs text-muted-foreground">
              {" "}
              · {row.modelLabel ?? "Unavailable"}
            </span>
          </span>
        </button>
        {evidence.length ? (
          <div className="max-w-96 px-1.5 pb-1 text-2xs text-muted-foreground">
            {evidence.length > 1 ? <span className="block">From your runs</span> : null}
            {evidence.map((model) => (
              <Tooltip key={`${model.instanceId}:${model.model}`}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="block text-left underline-offset-2 hover:underline focus-visible:underline"
                    />
                  }
                >
                  {evidence.length === 1
                    ? `From your runs · ${model.model}: `
                    : `${model.model} · ${model.instanceId}: `}
                  {model.yourRuns}
                </TooltipTrigger>
                <TooltipPopup>
                  <div className="max-w-sm whitespace-pre-line">
                    {modelRankingRunDetails([model])}
                  </div>
                </TooltipPopup>
              </Tooltip>
            ))}
          </div>
        ) : null}
      </div>
      <Menu>
        <MenuTrigger
          render={<Button size="icon-xs" variant="ghost-muted" />}
          aria-label={`Options for ${entry.label}`}
          disabled={disabled}
        >
          <MoreHorizontalIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          {ModelRankingTier.literals.map((destination) => (
            <MenuItem
              key={destination}
              disabled={tier === destination}
              onClick={() => onPosition(destination)}
            >
              Move to {destination}
            </MenuItem>
          ))}
          <MenuItem disabled={tier === null} onClick={() => onPosition(null)}>
            Unranked
          </MenuItem>
          <MenuItem
            disabled={tierIndex === null || tierIndex === 0}
            onClick={() => onPosition(tier, tierIndex! - 1)}
          >
            Move left
          </MenuItem>
          <MenuItem
            disabled={tierIndex === null || tierIndex === lastIndex}
            onClick={() => onPosition(tier, tierIndex! + 1)}
          >
            Move right
          </MenuItem>
          {onEditNote ? <MenuItem onClick={onEditNote}>Edit note</MenuItem> : null}
        </MenuPopup>
      </Menu>
    </li>
  );
}

function ModelRankingNoteField({
  value,
  initialText,
  label,
  disabled,
  onSave,
}: {
  value: string;
  initialText: string;
  label: string;
  disabled: boolean;
  onSave: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(() => TextDraft.change(TextDraft.create(value), initialText));
  const current = TextDraft.receive(draft, value);
  if (draft.source !== value) setDraft(current);
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const commit = async () => {
    if (disabled || inFlight.current) return;
    const submitted = TextDraft.commitValue(current);
    if (submitted === null) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      if (await onSave(submitted))
        setDraft((previous) => TextDraft.acknowledge(previous, submitted));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };
  return (
    <div className="space-y-2">
      <Textarea
        aria-label={label}
        size="sm"
        rows={2}
        maxLength={500}
        value={current.text}
        placeholder="What works well for this task? Agents receive a short excerpt."
        disabled={disabled || submitting}
        onChange={(event) => {
          const text = event.target.value;
          setDraft((previous) => TextDraft.change(TextDraft.receive(previous, value), text));
        }}
        onBlur={() => void commit()}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || submitting || TextDraft.commitValue(current) === null}
        onClick={() => void commit()}
      >
        Save note
      </Button>
    </div>
  );
}
