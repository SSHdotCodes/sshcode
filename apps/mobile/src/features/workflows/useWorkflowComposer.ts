import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import {
  COMPOSER_CONTEXT_MAX_RECORDS,
  type EnvironmentId,
  type ThreadId,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { useCallback, useRef, useState } from "react";
import { Alert } from "react-native";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  setComposerDraftContext,
  setComposerDraftText,
} from "../../state/use-composer-drafts";
import { useAtomCommand } from "../../state/use-atom-command";
import { startWorkflow, useWorkflowsEnabled } from "./state";
import { workflowCommand } from "./workflowCommand";
import {
  selectedComposerWorkflow,
  workflowComposerRecord,
  workflowComposerTask,
} from "./workflowComposer";

export function useWorkflowComposer({
  environmentId,
  threadId,
  draftKey,
  connected,
  available,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftKey: string;
  connected: boolean;
  available: boolean;
}) {
  const [enabled] = useWorkflowsEnabled(environmentId);
  const navigation = useNavigation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const inFlight = useRef(false);
  const permission = useAtomValue(startWorkflow.permissionAtom(environmentId));
  const start = useAtomCommand(startWorkflow, { reportFailure: false });
  const openPicker = useCallback(() => setPickerOpen(true), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const pick = useCallback(
    (workflow: WorkflowDefinition, draftText?: string) => {
      const snapshot = getComposerDraftSnapshot(draftKey);
      // `@name` passes the draft without its query; `/workflow` reads the stored draft.
      const draft = draftText === undefined ? snapshot : { ...snapshot, text: draftText };
      const record = workflowComposerRecord(workflow);
      const old = selectedComposerWorkflow(draft.text, draft.context);
      const records = draft.context?.records.filter((entry) => entry.kind !== "workflow") ?? [];
      if (records.length >= COMPOSER_CONTEXT_MAX_RECORDS) {
        Alert.alert("Too many context items", "Remove a context item and try again.");
        return;
      }
      const text = old
        ? workflowComposerTask(draft.text, old)
        : (workflowCommand(draft.text, true) ?? draft.text);
      setComposerDraftContext(draftKey, { version: 1, records: [...records, record] });
      setComposerDraftText(
        draftKey,
        `${formatComposerContextReference(record)}${text ? ` ${text}` : " "}`,
      );
      setPickerOpen(false);
    },
    [draftKey],
  );
  const interceptSend = async () => {
    if (!enabled || !available) return false;
    const draft = getComposerDraftSnapshot(draftKey);
    if (workflowCommand(draft.text, true) !== null) {
      setPickerOpen(true);
      return true;
    }
    const record = selectedComposerWorkflow(draft.text, draft.context);
    if (!record) return false;
    if (inFlight.current) return true;
    if (!connected || !permission) {
      Alert.alert(
        "Cannot start workflow",
        "Reconnect with permission to control this chat, then try again.",
      );
      return true;
    }
    const task = workflowComposerTask(draft.text, record);
    if (!task) {
      Alert.alert("Add a task", "Write what this team should do, then send.");
      return true;
    }
    if (
      draft.attachments.length ||
      draft.context?.records.some((entry) => entry.contextId !== record.contextId)
    ) {
      Alert.alert(
        "Send this task as text",
        "Remove other attachments and context before starting a workflow.",
      );
      return true;
    }
    inFlight.current = true;
    try {
      const result = await start({
        environmentId,
        input: { workflowId: record.workflowId, chatThreadId: threadId, task },
      });
      if (result._tag === "Success") {
        clearComposerDraftContent(draftKey, { expectedContent: draft });
        navigation.dispatch(
          StackActions.push("Workflows", { environmentId, runId: result.value.runId }),
        );
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Could not start workflow",
          error instanceof Error ? error.message : "Your draft is saved. Try again.",
        );
      }
    } catch (error) {
      Alert.alert(
        "Could not start workflow",
        error instanceof Error ? error.message : "Your draft is saved. Try again.",
      );
    } finally {
      inFlight.current = false;
    }
    return true;
  };
  return {
    enabled: enabled && available,
    pickerOpen: enabled && available && pickerOpen,
    openPicker,
    closePicker,
    pick,
    interceptSend,
  };
}
