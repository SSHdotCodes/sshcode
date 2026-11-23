import { accountPinAfterPick } from "@t3tools/client-runtime/account-routes";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2Subagent,
  type ProjectId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { LoaderCircleIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { readThreadShells } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { newSubagentCandidates } from "./newSubagentModels";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { TraitsPicker } from "./TraitsPicker";

interface NewSubagentProps {
  readonly environmentId: EnvironmentId;
  /** The lead chat: it gets the card and the result. */
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
}

/**
 * Start a subagent yourself: a row in the chat's agent list opens a small form with the
 * task and the model. The subagent works beside the chat's agent, which gets its card and
 * its result. Nothing is computed, and nothing reaches the agent, until the form is used.
 */
export function NewSubagentControl(props: NewSubagentProps) {
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const [open, setOpen] = useState(false);
  // What was typed outlives the popover: closing it by a stray click loses nothing.
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<PickedModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canOperate) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<ThreadDetailsControl size="sm" variant="ghost" part="row" tone="muted" />}
      >
        <PlusIcon aria-hidden className="size-4 shrink-0" />
        New subagent
      </PopoverTrigger>
      <PopoverPopup side="left" align="start" width="lg">
        <NewSubagentForm
          {...props}
          busy={busy}
          setBusy={setBusy}
          error={error}
          setError={setError}
          draft={draft}
          onDraftChange={setDraft}
          picked={picked}
          onPick={setPicked}
          onStarted={() => {
            setDraft("");
            setOpen(false);
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** The model picked in the form, and whether its account was picked by name. */
interface PickedModel {
  readonly selection: ModelSelection;
  readonly accountPinned: boolean;
}

function NewSubagentForm(
  props: NewSubagentProps & {
    readonly busy: boolean;
    readonly setBusy: (busy: boolean) => void;
    readonly error: string | null;
    readonly setError: (error: string | null) => void;
    readonly draft: string;
    readonly onDraftChange: (draft: string) => void;
    /** Kept by the row, like the draft: closing the form does not lose the choice. */
    readonly picked: PickedModel | null;
    readonly onPick: (picked: PickedModel) => void;
    readonly onStarted: () => void;
  },
) {
  const { environmentId, threadId, projectId, providers, subagents } = props;
  const settings = useEnvironmentSettings(environmentId);
  const nowMinute = useNowMinute();
  const candidates = useMemo(
    () =>
      newSubagentCandidates({
        providers,
        settings,
        projectId,
        subagents,
        // Read once while the form is open, not subscribed to: the choices are the models
        // the owner starts chats with.
        history: readThreadShells()
          .filter((chat) => chat.environmentId === environmentId)
          .map((chat) => ({
            createdBy: chat.source.createdBy,
            createdAt: Date.parse(chat.createdAt),
            modelSelection: chat.modelSelection,
          })),
        now: Date.parse(`${nowMinute}Z`),
      }),
    [environmentId, nowMinute, projectId, providers, settings, subagents],
  );
  const startSubagent = useAtomCommand(threadEnvironment.startSubagent, { reportFailure: false });
  // Until one is picked: what this chat's subagents last ran on, with that run's options.
  const chosen = props.picked?.selection ?? null;
  const accountPinned = props.picked?.accountPinned === true;
  const { busy, setBusy, error, setError } = props;
  const usual = candidates[0];
  const selection: ModelSelection | null =
    chosen ??
    (usual === undefined
      ? null
      : createModelSelection(usual.instanceId, usual.model, usual.options));
  // The full picker, as in the composer: every model, its account, effort and speed.
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(providers),
          settings,
          projectId,
        ),
      ),
    [projectId, providers, settings],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(settings, providers, selection?.instanceId, selection?.model),
    [providers, selection?.instanceId, selection?.model, settings],
  );
  const selectedEntry = instanceEntries.find((entry) => entry.instanceId === selection?.instanceId);

  if (selection === null) {
    return (
      <div className="flex flex-col gap-1.5">
        <PopoverTitle>New subagent</PopoverTitle>
        <p className="text-xs text-muted-foreground">
          No model is ready to run one. Turn a provider on in Settings first.
        </p>
      </div>
    );
  }

  const task = props.draft.trim();
  const start = async () => {
    if (task.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const result = await startSubagent({
      environmentId,
      input: { threadId, task, modelSelection: selection, creationSource: "web" },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      // What was typed stays in the box.
      setError(
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : "The subagent could not be started. Try again.",
      );
      return;
    }
    props.onStarted();
  };

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <PopoverTitle>New subagent</PopoverTitle>
      <Textarea
        autoFocus
        size="sm"
        value={props.draft}
        disabled={busy}
        placeholder="What should it do?"
        aria-label="Task for the new subagent"
        onChange={(event) => {
          props.onDraftChange(event.currentTarget.value);
          if (error !== null) setError(null);
        }}
        onKeyDown={(event) => {
          // Return adds a line, as in any task description; ⌘Return starts it.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void start();
          }
        }}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <ProviderModelPicker
          environmentId={environmentId}
          disabled={busy}
          activeInstanceId={selection.instanceId}
          model={selection.model}
          activeModelOptions={selection.options}
          lockedProvider={null}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          isComposerOwned={false}
          accountSession="new"
          balanceAccounts={settings.balanceAccounts}
          accountPinned={accountPinned}
          triggerClassName="min-w-0 max-w-full shrink"
          triggerAriaLabel="Model for the new subagent"
          onInstanceModelChange={(instanceId, model, options, accountPick) => {
            props.onPick({
              selection: createModelSelection(instanceId, model, options),
              accountPinned: accountPinAfterPick({
                pinned: accountPinned,
                previousInstanceId: selection.instanceId,
                nextInstanceId: instanceId,
                accountPick: accountPick === true,
              }),
            });
          }}
        />
        {selectedEntry === undefined ? null : (
          <TraitsPicker
            provider={selectedEntry.driverKind}
            instanceId={selectedEntry.instanceId}
            models={selectedEntry.models}
            model={selection.model}
            prompt=""
            onPromptChange={() => {}}
            modelOptions={selection.options ?? []}
            allowPromptInjectedEffort={false}
            planModeEnabled={false}
            disabled={busy}
            triggerClassName="min-w-0 max-w-full shrink-0"
            onModelOptionsChange={(options) =>
              props.onPick({
                selection: createModelSelection(selection.instanceId, selection.model, options),
                accountPinned,
              })
            }
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        {error === null ? (
          <p className="min-w-0 text-2xs text-muted-foreground">
            It works beside this chat&rsquo;s agent, which gets the result.
          </p>
        ) : (
          <p role="alert" className="min-w-0 text-2xs text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" size="sm" className="shrink-0" disabled={task.length === 0 || busy}>
          {busy ? <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" /> : null}
          {busy ? "Starting" : "Start"}
        </Button>
      </div>
    </form>
  );
}
