import {
  WORKFLOW_MAX_AGENTS_PER_NODE,
  type EnvironmentId,
  type WorkflowAgentNode,
  type WorkflowDefinition,
  type WorkflowIssue,
  type WorkflowNode,
  type WorkflowNoteNode,
} from "@t3tools/contracts";
import {
  createModelSelection,
  getModelSelectionStringOptionValue,
  isReasoningSelectDescriptor,
} from "@t3tools/shared/model";
import { ArrowLeftRightIcon, CircleAlertIcon, Trash2Icon } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { BOX_COLORS } from "./WorkflowCanvasParts";
import { agentTitle, isAgent, issueKey } from "./workflowGraph";
import { changeWorkflowModel, type useWorkflowModelCatalog } from "./workflowModels";
import styles from "./workflows.module.css";

type Catalog = ReturnType<typeof useWorkflowModelCatalog>;

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function WorkflowInspector({
  environmentId,
  doc,
  canEdit,
  catalog,
  selectedNode,
  selectedEdgeId,
  selectionCount,
  issues,
  onUpdateNode,
  onUpdateDoc,
  onDelete,
}: {
  readonly environmentId: EnvironmentId;
  readonly doc: WorkflowDefinition;
  readonly canEdit: boolean;
  readonly catalog: Catalog;
  readonly selectedNode: WorkflowNode | undefined;
  readonly selectedEdgeId: string | undefined;
  readonly selectionCount: number;
  readonly issues: ReadonlyArray<WorkflowIssue>;
  readonly onUpdateNode: (
    id: string,
    patch: (node: WorkflowNode) => WorkflowNode,
    record?: boolean,
  ) => void;
  readonly onUpdateDoc: (
    update: (current: WorkflowDefinition) => WorkflowDefinition,
    record?: boolean,
  ) => void;
  readonly onDelete: () => void;
}) {
  let body: ReactNode;
  if (selectedNode?.kind === "agent") {
    body = (
      <AgentFields
        key={selectedNode.id}
        environmentId={environmentId}
        node={selectedNode}
        catalog={catalog}
        disabled={!canEdit}
        isLead={doc.rootNodeId === selectedNode.id}
        issues={issues.filter((issue) => issue.nodeId === selectedNode.id)}
        onChange={(patch, record) =>
          onUpdateNode(
            selectedNode.id,
            (node) =>
              node.kind !== "agent"
                ? node
                : typeof patch === "function"
                  ? patch(node)
                  : { ...node, ...patch },
            record,
          )
        }
      />
    );
  } else if (selectedNode?.kind === "note") {
    body = (
      <NoteFields
        key={selectedNode.id}
        note={selectedNode}
        agents={doc.nodes.filter(isAgent)}
        disabled={!canEdit}
        onChange={(patch, record) =>
          onUpdateNode(selectedNode.id, (node) => ({ ...node, ...patch }) as WorkflowNode, record)
        }
      />
    );
  } else if (selectedEdgeId !== undefined) {
    const edge = doc.edges.find((entry) => entry.id === selectedEdgeId);
    body = edge ? (
      <div className="flex flex-col gap-4">
        <Field label="Arrow">
          <ToggleGroup
            aria-label="Arrow kind"
            variant="segmented"
            className="w-full *:flex-1"
            value={[edge.kind]}
            disabled={!canEdit}
            onValueChange={(next) => {
              const kind = next[0];
              if (kind !== "delegates" && kind !== "then") return;
              onUpdateDoc((current) => ({
                ...current,
                edges: current.edges.map((entry) =>
                  entry.id === edge.id ? { ...entry, kind } : entry,
                ),
              }));
            }}
          >
            <ToggleGroupItem value="delegates">Starts</ToggleGroupItem>
            <ToggleGroupItem value="then">Then</ToggleGroupItem>
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            {edge.kind === "delegates"
              ? "The box at the tail starts the box at the head as its agent."
              : "The head starts after the tail finishes, and gets its result."}
          </p>
        </Field>
        <Button
          variant="outline"
          size="sm"
          disabled={!canEdit}
          onClick={() =>
            onUpdateDoc((current) => ({
              ...current,
              edges: current.edges.map((entry) =>
                entry.id === edge.id ? { ...entry, from: entry.to, to: entry.from } : entry,
              ),
            }))
          }
        >
          <ArrowLeftRightIcon />
          Reverse
        </Button>
      </div>
    ) : (
      <p className="text-sm text-muted-foreground">
        This dotted line adds the note to the agent’s brief.
      </p>
    );
  } else if (selectionCount > 1) {
    body = <p className="text-sm text-muted-foreground">{selectionCount} selected</p>;
  } else {
    return null;
  }
  return (
    <aside
      aria-label="Selection"
      className={`${styles.panel} pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-popover shadow-lg`}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">{body}</div>
      <div className="border-t border-border/60 p-2">
        <Button
          variant="ghost-destructive"
          size="sm"
          className="w-full"
          disabled={!canEdit}
          onClick={onDelete}
        >
          <Trash2Icon />
          Delete
          <Kbd className="ml-auto">⌫</Kbd>
        </Button>
      </div>
    </aside>
  );
}

function AgentFields({
  environmentId,
  node,
  catalog,
  disabled,
  isLead,
  issues,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: WorkflowAgentNode;
  readonly catalog: Catalog;
  readonly disabled: boolean;
  readonly isLead: boolean;
  readonly issues: ReadonlyArray<WorkflowIssue>;
  readonly onChange: (
    patch: Partial<WorkflowAgentNode> | ((node: WorkflowAgentNode) => WorkflowAgentNode),
    record?: boolean,
  ) => void;
}) {
  const fallback = catalog.instanceEntries.find((entry) => entry.enabled && entry.isAvailable);
  const countMode = node.count.kind === "upTo" ? "many" : node.count.n > 1 ? "exact" : "one";
  const countValue = node.count.kind === "upTo" ? node.count.max : node.count.n;
  const typing = useTypingStep();
  const effort = catalog.instanceEntries
    .find((entry) => entry.instanceId === node.model?.instanceId)
    ?.models.find((model) => model.slug === node.model?.model)
    ?.capabilities?.optionDescriptors?.find(isReasoningSelectDescriptor);
  const effortItems = [
    { value: "", label: "Default" },
    ...(effort?.options.map((option) => ({ value: option.id, label: option.label })) ?? []),
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className={`${styles.hand} truncate text-xl`}>{agentTitle(node)}</div>
      {issues.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {issues.map((issue) => (
            <li key={issueKey(issue)} className="flex items-start gap-1.5 text-xs text-destructive">
              <CircleAlertIcon className="mt-px size-3 shrink-0" />
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <Field label="Model">
        {node.model || fallback ? (
          <div className="flex flex-wrap items-center gap-1">
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={node.model?.instanceId ?? fallback!.instanceId}
              model={node.model?.model ?? ""}
              lockedProvider={null}
              instanceEntries={catalog.instanceEntries}
              modelOptionsByInstance={catalog.modelOptionsByInstance}
              disabled={disabled}
              triggerClassName="-ml-1.5 min-w-0 max-w-full self-start"
              {...(node.model ? {} : { triggerLabel: "Pick a model" })}
              onInstanceModelChange={(instanceId, model) =>
                onChange((current) => ({
                  ...current,
                  model: changeWorkflowModel(
                    catalog.instanceEntries,
                    current.model,
                    instanceId,
                    model,
                  ),
                }))
              }
            />
            {effort && effort.options.length > 0 ? (
              <Select
                items={effortItems}
                value={getModelSelectionStringOptionValue(node.model, effort.id) ?? ""}
                disabled={disabled}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  onChange((current) => {
                    if (!current.model) return current;
                    const options =
                      current.model.options?.filter((option) => option.id !== effort.id) ?? [];
                    if (value) options.push({ id: effort.id, value });
                    return {
                      ...current,
                      model: createModelSelection(
                        current.model.instanceId,
                        current.model.model,
                        options,
                      ),
                    };
                  });
                }}
              >
                <SelectTrigger size="compact" variant="ghost" aria-label="Reasoning effort">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {effortItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No models available on this environment.</p>
        )}
      </Field>
      <Field label="Label">
        <Input
          size="sm"
          placeholder="Planner, Frontend…"
          value={node.label}
          maxLength={80}
          disabled={disabled}
          onFocus={typing.onFocus}
          onChange={(event) => onChange({ label: event.target.value }, typing.take())}
        />
      </Field>
      {isLead && countMode === "one" ? (
        <p className="text-xs text-muted-foreground">
          This box leads the run, so it’s always one agent.
        </p>
      ) : (
        <Field label="How many">
          <ToggleGroup
            aria-label="How many agents"
            variant="segmented"
            className="w-full *:flex-1"
            value={[countMode]}
            disabled={disabled}
            onValueChange={(next) => {
              const mode = next[0];
              if (mode === "one") onChange({ count: { kind: "exact", n: 1 } });
              if (mode === "exact")
                onChange({ count: { kind: "exact", n: Math.max(2, countValue) } });
              if (mode === "many")
                onChange({
                  count: { kind: "upTo", max: Math.max(2, countValue === 1 ? 8 : countValue) },
                });
            }}
          >
            <ToggleGroupItem value="one">One</ToggleGroupItem>
            <ToggleGroupItem value="exact">Exactly</ToggleGroupItem>
            <ToggleGroupItem value="many">Many</ToggleGroupItem>
          </ToggleGroup>
          {countMode !== "one" ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {countMode === "many" ? "Up to" : "Agents"}
              </span>
              <NumberField
                size="sm"
                className="w-28"
                value={countValue}
                min={countMode === "many" ? 1 : 2}
                max={WORKFLOW_MAX_AGENTS_PER_NODE}
                disabled={disabled}
                onValueChange={(value) => {
                  if (value === null) return;
                  // Exactly means at least 2; typing 1 there must not silently switch to One.
                  const least = countMode === "many" ? 1 : 2;
                  const n = Math.round(
                    Math.min(WORKFLOW_MAX_AGENTS_PER_NODE, Math.max(least, value)),
                  );
                  onChange({
                    count: countMode === "many" ? { kind: "upTo", max: n } : { kind: "exact", n },
                  });
                }}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement />
                  <NumberFieldInput aria-label="Agent count" />
                  <NumberFieldIncrement />
                </NumberFieldGroup>
              </NumberField>
            </div>
          ) : null}
          {countMode === "many" ? (
            <p className="text-xs text-muted-foreground">The parent decides how many to start.</p>
          ) : null}
        </Field>
      )}
      <div className="flex flex-col gap-4">
        <Field label="Files">
          <ToggleGroup
            aria-label="Isolation"
            variant="segmented"
            className="w-full *:flex-1"
            value={[node.isolation]}
            disabled={disabled}
            onValueChange={(next) => {
              const isolation = next[0];
              if (isolation === "shared" || isolation === "worktree") onChange({ isolation });
            }}
          >
            <ToggleGroupItem value="shared">Shared</ToggleGroupItem>
            <ToggleGroupItem value="worktree">Worktree</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      </div>
      <Field label="Brief">
        <Textarea
          size="sm"
          placeholder="What this agent should do"
          value={node.instructions}
          maxLength={4_000}
          disabled={disabled}
          onFocus={typing.onFocus}
          onChange={(event) => onChange({ instructions: event.target.value }, typing.take())}
        />
      </Field>
      <Field label="What you wrote">
        <Textarea
          size="sm"
          value={node.text}
          maxLength={2_000}
          disabled={disabled}
          onFocus={typing.onFocus}
          onChange={(event) => onChange({ text: event.target.value }, typing.take())}
        />
      </Field>
      <Field label="Color">
        <div className="flex items-center gap-1.5">
          <ColorSwatch
            label="No color"
            active={node.color === undefined}
            disabled={disabled}
            onClick={() => onChange(({ color: _color, ...rest }) => rest)}
            css="var(--contrast-foreground)"
          />
          {BOX_COLORS.map((color) => (
            <ColorSwatch
              key={color.id}
              label={color.id}
              active={node.color === color.id}
              disabled={disabled}
              css={color.css}
              onClick={() => onChange({ color: color.id })}
            />
          ))}
        </div>
      </Field>
    </div>
  );
}

function ColorSwatch({
  label,
  css,
  active,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly css: string;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "size-6 rounded-full border-2 border-background ring-1 ring-border transition-transform hover:scale-110 disabled:opacity-50",
        active && "ring-2 ring-ring",
      )}
      style={{ background: css }}
    />
  );
}

/**
 * Typing records one undo step per field visit, taken on the first change, so
 * focusing a field without editing leaves undo alone.
 */
function useTypingStep() {
  const fresh = useRef(false);
  return {
    onFocus: () => {
      fresh.current = true;
    },
    take: () => {
      const record = fresh.current;
      fresh.current = false;
      return record;
    },
  };
}

function NoteFields({
  note,
  agents,
  disabled,
  onChange,
}: {
  readonly note: WorkflowNoteNode;
  readonly agents: ReadonlyArray<WorkflowAgentNode>;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<WorkflowNoteNode>, record?: boolean) => void;
}) {
  const typing = useTypingStep();
  return (
    <div className="flex flex-col gap-4">
      <Field label="Note">
        <Textarea
          size="sm"
          value={note.text}
          maxLength={4_000}
          disabled={disabled}
          onFocus={typing.onFocus}
          onChange={(event) => onChange({ text: event.target.value }, typing.take())}
        />
      </Field>
      <Field label="For">
        <select
          aria-label="Who reads this note"
          className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
          value={note.attachedTo ?? ""}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              attachedTo: agents.find((agent) => agent.id === event.target.value)?.id ?? null,
            })
          }
        >
          <option value="">The whole run (the lead reads it)</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agentTitle(agent)}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Draw an arrow from the note to a box to add it to that agent’s brief.
        </p>
      </Field>
    </div>
  );
}
