import { HarnessMascot, HarnessMascotAgentId, HarnessMascotDriver } from "../HarnessMascot";
import { harnessMascotForDriver } from "@t3tools/shared/harnessMascots";
import { type RuntimeRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { memo, useCallback, useContext, useEffect, useRef, useState } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon } from "lucide-react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";
import ChatMarkdown from "../ChatMarkdown";
import { isInsideComposerFloatingLayer } from "./composerEventScope";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  /** Resolves file links in the question text. */
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled?: boolean;
  respondingRequestIds: RuntimeRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
  /** The composer's command menu is open over the card: show only its header meanwhile. */
  menuOpen?: boolean;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  cwd,
  threadRef,
  disabled = false,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onDismiss,
  menuOpen = false,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      cwd={cwd}
      threadRef={threadRef}
      disabled={disabled}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onDismiss={onDismiss}
      menuOpen={menuOpen}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  cwd,
  threadRef,
  disabled,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onDismiss,
  menuOpen,
}: {
  prompt: PendingUserInput;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled: boolean;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
  menuOpen: boolean;
}) {
  const mascotDriver = useContext(HarnessMascotDriver);
  const mascotAgentId = useContext(HarnessMascotAgentId);
  const hasMascot = harnessMascotForDriver(mascotDriver, mascotAgentId) !== null;
  // Message-mode requests remain answerable after their provider turn ends.
  const canRespond = prompt.responseCapability !== "not_resumable";
  const responseDisabled = disabled || isResponding || !canRespond;
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const clearAutoAdvance = useCallback(() => {
    if (autoAdvanceTimerRef.current === null) return;
    window.clearTimeout(autoAdvanceTimerRef.current);
    autoAdvanceTimerRef.current = null;
  }, []);
  const onAdvanceRef = useRef(onAdvance);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  // Collapsing hides everything but the header so a tall prompt stops covering
  // the thread the user is trying to read. Scoped to a single question: the card
  // is keyed by request id so the next prompt starts expanded, and storing the
  // collapsed question's id (rather than a bare flag) reopens the card when the
  // prompt advances to its next question, which can happen without a click —
  // sending from the composer advances the active question.
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  // The command menu opens over the same spot, so the options give way while it is open.
  const isCollapsed =
    menuOpen || (collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id);

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  useEffect(() => {
    if (!activeQuestion || activeQuestion.multiSelect || !optimisticSingleSelect) {
      return;
    }
    if (optimisticSingleSelect.questionId !== activeQuestion.id) {
      setOptimisticSingleSelect(null);
      return;
    }
    if (
      progress.customAnswer.trim().length === 0 &&
      progress.selectedOptionValues.includes(optimisticSingleSelect.optionValue)
    ) {
      setOptimisticSingleSelect(null);
    }
  }, [
    activeQuestion,
    optimisticSingleSelect,
    progress.customAnswer,
    progress.selectedOptionValues,
  ]);

  // A delayed answer only advances its own question, while permission remains granted.
  useEffect(() => {
    if (responseDisabled || activeQuestion?.id === undefined) clearAutoAdvance();
    return clearAutoAdvance;
  }, [activeQuestion?.id, clearAutoAdvance, responseDisabled]);

  const handleOptionSelection = useCallback(
    (questionId: string, optionValue: string) => {
      if (responseDisabled) return;
      if (activeQuestion?.multiSelect) {
        onToggleOption(questionId, optionValue);
        return;
      }
      setOptimisticSingleSelect({ questionId, optionValue });
      onToggleOption(questionId, optionValue);
      clearAutoAdvance();
      autoAdvanceTimerRef.current = window.setTimeout(() => {
        autoAdvanceTimerRef.current = null;
        onAdvanceRef.current();
      }, 200);
    },
    [activeQuestion, clearAutoAdvance, responseDisabled, onToggleOption],
  );

  // Keyboard shortcut: number keys 1-9 select corresponding options when focus is
  // outside editable fields. Multi-select prompts toggle options in place; single-
  // select prompts keep the existing auto-advance behavior. Collapsed prompts opt
  // out, since the numbers they refer to are not on screen.
  useEffect(() => {
    if (!activeQuestion || responseDisabled || isCollapsed) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        isInsideComposerFloatingLayer(target)
      ) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest(
          '[contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        )
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      handleOptionSelection(activeQuestion.id, option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, handleOptionSelection, isCollapsed, responseDisabled]);

  if (!activeQuestion) {
    return null;
  }

  const customAnswerActive = progress.customAnswer.trim().length > 0;

  return (
    <Collapsible
      open={!isCollapsed}
      onOpenChange={(open) => {
        setCollapsedQuestionId(open ? null : activeQuestion.id);
      }}
    >
      <div className="flex items-center">
        <CollapsibleTrigger
          render={<ComposerBanner.Row render={<button type="button" />} />}
          className="min-w-0 flex-1"
          title={
            isCollapsed ? "Show the question and its options" : "Hide the question and its options"
          }
          data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
        >
          {/* In the icon column: as a bare child of the row's grid it landed on a line of its own. */}
          {hasMascot ? (
            <ComposerBanner.Icon className="[&>svg]:size-6">
              <HarnessMascot state="waiting" size={24} />
            </ComposerBanner.Icon>
          ) : null}
          <ComposerBanner.Content>
            <span className="shrink-0 font-medium text-muted-foreground">
              {activeQuestion.header}
            </span>
            {isCollapsed ? (
              <span className="min-w-0 flex-1 truncate text-secondary-label">
                {activeQuestion.question}
              </span>
            ) : null}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {prompt.questions.length > 1 ? (
              <span className="text-3xs font-medium text-muted-foreground tabular-nums">
                {questionIndex + 1}/{prompt.questions.length}
              </span>
            ) : null}
            <ComposerBanner.ToggleIcon expanded={!isCollapsed} />
          </ComposerBanner.Actions>
        </CollapsibleTrigger>
        {prompt.dismissible ? (
          <ComposerBanner.Dismiss
            type="button"
            className="shrink-0"
            aria-label="Dismiss question without answering"
            title="Dismiss question without answering"
            disabled={isResponding}
            data-pending-user-input-dismiss
            onClick={(event) => {
              event.preventDefault();
              if (isResponding) return;
              clearAutoAdvance();
              onDismiss(prompt.requestId);
            }}
          />
        ) : null}
      </div>
      <CollapsiblePanel>
        <ComposerBanner.Scroll>
          <ComposerBanner.Body className="pe-1 pb-1 wrap-anywhere">
            <ChatMarkdown
              text={activeQuestion.question}
              cwd={cwd}
              threadRef={threadRef}
              className="text-foreground/85"
            />
            {activeQuestion.multiSelect ? (
              <p className="mt-1 text-secondary-label text-xs">
                {activeQuestion.allowCustomAnswer === false
                  ? "Select one or more options."
                  : "Select one or more options. You can add your own words below too."}
              </p>
            ) : null}
            <div className="mt-2 space-y-0.5">
              {activeQuestion.options.map((option, index) => {
                const optionValue = option.value ?? option.label;
                const isOptimisticallySelected =
                  optimisticSingleSelect?.questionId === activeQuestion.id &&
                  optimisticSingleSelect.optionValue === optionValue;
                const isSelected =
                  isOptimisticallySelected ||
                  // Typed text replaces a single choice and adds to a multiple one.
                  ((activeQuestion.multiSelect || !customAnswerActive) &&
                    progress.selectedOptionValues.includes(optionValue));
                const shortcutKey = index < 9 ? index + 1 : null;
                const className = cn(
                  "group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  isSelected
                    ? "bg-muted/55 text-foreground"
                    : "bg-transparent text-foreground/85 hover:bg-muted/30",
                  responseDisabled && "opacity-50 cursor-not-allowed",
                  !responseDisabled && "cursor-pointer",
                );
                const content = (
                  <>
                    <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.description && option.description !== option.label ? (
                        <span className="text-secondary-label text-2xs">{option.description}</span>
                      ) : null}
                    </div>
                    {isSelected ? (
                      <CheckIcon className="size-3.5 shrink-0 text-primary" />
                    ) : shortcutKey !== null ? (
                      <kbd
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center text-3xs font-medium text-muted-foreground tabular-nums",
                        )}
                      >
                        {shortcutKey}
                      </kbd>
                    ) : null}
                  </>
                );
                return (
                  <button
                    key={`${activeQuestion.id}:${optionValue}`}
                    type="button"
                    aria-pressed={isSelected}
                    data-question-option
                    disabled={responseDisabled}
                    onClick={() => {
                      handleOptionSelection(activeQuestion.id, optionValue);
                    }}
                    className={className}
                  >
                    {content}
                  </button>
                );
              })}
            </div>
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      </CollapsiblePanel>
    </Collapsible>
  );
});
