import { useNavigation } from "@react-navigation/native";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sameMessageRewindPlan } from "@t3tools/client-runtime/state/thread-checkpoints";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { Alert } from "react-native";
import { MessageMenuContext, type MessageMenuAction } from "../../native/MessageMenuContext";
import type { ThreadFeedMessage } from "../../lib/threadActivity";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  appendComposerDraftAttachments,
  getComposerDraftSnapshot,
  setComposerDraftContext,
  setComposerDraftText,
} from "../../state/use-composer-drafts";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { assetEnvironment } from "../../state/assets";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { usePreparedConnection } from "../../state/session";
import { COMPOSER_ATTACHMENT_DIRECTORY } from "../../lib/composerAttachmentFiles";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import * as Option from "effect/Option";
import { useV2ItemSupport } from "../../state/v2-item-support";
import { waitForThreadShellReady } from "./threadForkNavigation";
import {
  canForkMessage,
  editMessageConfirmationText,
  editMessageTarget,
  forkMessageInput,
  mergeRewoundPrompt,
  revertMessageInput,
  rollbackSettled,
} from "./messageWorkflows";

export function MessageWorkflowProvider(props: {
  readonly children: ReactNode;
  readonly message: ThreadFeedMessage;
  readonly projectedItem: NonNullable<ThreadFeedMessage["projectedItem"]>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly draftKey: string | null;
  readonly canOperate: boolean;
  readonly supportsRollback: boolean;
  readonly active: boolean;
  readonly rewindInProgress: boolean;
  readonly onRewindingChange: (rewinding: boolean) => void;
}) {
  const navigation = useNavigation();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const latestProps = useRef(props);
  useLayoutEffect(() => {
    latestProps.current = props;
  }, [props]);
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: props.message.sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  const preparedConnection = usePreparedConnection(props.environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  const fork = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const revert = useAtomCommand(threadEnvironment.revertCheckpoint, { reportFailure: false });
  const targetAtom = useMemo(
    () =>
      Atom.make((get) => {
        const projection =
          get(
            environmentThreadDetails.threadAtom(
              scopeThreadRef(props.environmentId, props.threadId),
            ),
          )?.projection ?? null;
        return editMessageTarget({
          message: props.message,
          projection,
          threadId: props.threadId,
          canOperate: props.canOperate && props.draftKey !== null,
          supportsRollback: props.supportsRollback,
          active: props.active || props.rewindInProgress || busy,
        });
      }).pipe(Atom.withEquality(sameMessageRewindPlan)),
    [
      props.environmentId,
      props.threadId,
      props.message,
      props.canOperate,
      props.draftKey,
      props.supportsRollback,
      props.active,
      props.rewindInProgress,
      busy,
    ],
  );
  const target = useAtomValue(targetAtom);
  const canFork = canForkMessage({
    canOperate: props.canOperate && !busy,
    runStatus: support.run?.status,
    projectedItem: props.projectedItem,
    capabilities: support.providerSession?.capabilities,
  });
  const items: MessageMenuAction[] = [];
  if (canFork && props.message.runId !== null) {
    const runId = props.message.runId;
    items.push({
      text: "Fork from here",
      icon: "arrow.triangle.branch",
      onPress: () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        const targetThreadId = ThreadId.make(uuidv4());
        void fork(
          forkMessageInput(
            props.environmentId,
            props.message.sourceThreadId,
            targetThreadId,
            runId,
            props.threadTitle,
          ),
        )
          .then(async (result) => {
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            const atom = environmentThreadShells.threadShellAtom(
              scopeThreadRef(props.environmentId, targetThreadId),
            );
            const ready = await waitForThreadShellReady({
              read: () => appAtomRegistry.get(atom) !== null,
            });
            if (!ready)
              throw new Error(
                "The fork was created, but its chat did not reach this device. Reconnect and open it from the chat list.",
              );
            navigation.navigate("Thread", {
              environmentId: props.environmentId,
              threadId: targetThreadId,
            });
          })
          .catch((error: unknown) =>
            Alert.alert(
              "Could not open fork",
              error instanceof Error ? error.message : "Try again.",
            ),
          )
          .finally(() => {
            busyRef.current = false;
            setBusy(false);
          });
      },
    });
  }
  if (target !== null && props.draftKey !== null && props.message.runId !== null) {
    const draftKey = props.draftKey;
    const runId = props.message.runId;
    const perform = async (restoreFiles: boolean) => {
      if (busyRef.current || latestProps.current.rewindInProgress) return;
      const ref = scopeThreadRef(props.environmentId, props.threadId);
      const atom = environmentThreadDetails.threadAtom(ref);
      const current = appAtomRegistry.get(atom)?.projection ?? null;
      if (
        !sameMessageRewindPlan(
          editMessageTarget({
            message: props.message,
            projection: current,
            threadId: props.threadId,
            canOperate: props.canOperate,
            supportsRollback: props.supportsRollback,
            active:
              latestProps.current.active ||
              !latestProps.current.canOperate ||
              !latestProps.current.supportsRollback,
          }),
          target,
        )
      ) {
        Alert.alert(
          "Can't edit message",
          "The conversation changed. Try again when the run is finished.",
        );
        return;
      }
      busyRef.current = true;
      setBusy(true);
      props.onRewindingChange(true);
      const commandId = CommandId.make(uuidv4());
      const preparedFiles: DraftComposerAttachment[] = [];
      const preparedPaths: string[] = [];
      try {
        if (props.message.attachments.length > 0) {
          if (Option.isNone(preparedConnection))
            throw new Error("Reconnect to restore this message's attachments.");
          const { Directory, File, Paths } = await import("expo-file-system");
          const directory = new Directory(Paths.document, COMPOSER_ATTACHMENT_DIRECTORY);
          directory.create({ idempotent: true, intermediates: true });
          for (const attachment of props.message.attachments) {
            const result = await createAssetUrl({
              environmentId: props.environmentId,
              input: { resource: { _tag: "attachment", attachmentId: attachment.id } },
            });
            if (result._tag !== "Success") throw new Error(`Could not load ${attachment.name}.`);
            const url = resolveAssetUrl(
              preparedConnection.value.httpBaseUrl,
              result.value.relativeUrl,
            );
            if (!url) throw new Error(`Could not load ${attachment.name}.`);
            const file = new File(directory, `${uuidv4()}-attachment`);
            preparedPaths.push(file.uri);
            await File.downloadFileAsync(url, file);
            const common = {
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              fileUri: file.uri,
              uploadedAttachmentId: attachment.id,
              uploadEnvironmentId: props.environmentId,
            };
            preparedFiles.push(
              attachment.type === "image"
                ? { ...common, type: "image", previewUri: file.uri }
                : {
                    ...common,
                    type: "file",
                    ...(attachment.type === "file" &&
                    "source" in attachment &&
                    attachment.source?._tag === "pasted-text"
                      ? { source: attachment.source }
                      : {}),
                  },
            );
          }
        }
        const refreshed = appAtomRegistry.get(atom)?.projection ?? null;
        if (
          !sameMessageRewindPlan(
            editMessageTarget({
              message: props.message,
              projection: refreshed,
              threadId: props.threadId,
              canOperate: latestProps.current.canOperate,
              supportsRollback: latestProps.current.supportsRollback,
              active: latestProps.current.active,
            }),
            target,
          )
        )
          throw new Error("The conversation changed. Try again when the run is finished.");
        await new Promise<void>((resolve, reject) => {
          let accepted = false;
          let finished = false;
          let unsubscribe = () => {};
          const finish = (error?: Error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            unsubscribe();
            if (error) reject(error);
            else resolve();
          };
          const inspect = () => {
            const next = appAtomRegistry.get(atom)?.projection;
            if (!next) return;
            const status = rollbackSettled(next, runId, target.turnCount, commandId);
            if (status === "failed")
              finish(new Error(next.thread.rollbackFailure?.message ?? "Could not rewind."));
            else if (accepted && status === "complete") finish();
          };
          const timeout = setTimeout(
            () =>
              finish(
                new Error(
                  "The rewind is still pending. Check the conversation before trying again.",
                ),
              ),
            120_000,
          );
          unsubscribe = appAtomRegistry.subscribe(atom, inspect);
          void revert(
            revertMessageInput(
              props.environmentId,
              props.threadId,
              target.turnCount,
              commandId,
              restoreFiles && target.canRestoreFiles,
            ),
          )
            .then((result) => {
              if (result._tag === "Failure") {
                const error = squashAtomCommandFailure(result);
                finish(error instanceof Error ? error : new Error(String(error)));
                return;
              }
              accepted = true;
              inspect();
            })
            .catch((error: unknown) =>
              finish(error instanceof Error ? error : new Error("Could not rewind.")),
            );
        });
        const restored = mergeRewoundPrompt(
          getComposerDraftSnapshot(draftKey),
          props.message,
          preparedFiles,
        );
        setComposerDraftText(draftKey, restored.text);
        if (restored.context) setComposerDraftContext(draftKey, restored.context);
        appendComposerDraftAttachments(draftKey, restored.attachments, { restore: true });
        if (restored.duplicates.length > 0) {
          const { File } = await import("expo-file-system");
          for (const attachment of restored.duplicates) {
            try {
              if (attachment.fileUri) new File(attachment.fileUri).delete();
            } catch {
              /* Best effort cleanup. */
            }
          }
        }
        preparedPaths.length = 0;
      } catch (error) {
        if (preparedPaths.length > 0) {
          const { File } = await import("expo-file-system");
          for (const path of preparedPaths) {
            try {
              new File(path).delete();
            } catch {
              /* Best effort cleanup. */
            }
          }
        }
        Alert.alert(
          "Could not edit message",
          error instanceof Error ? error.message : "Try again.",
        );
      } finally {
        busyRef.current = false;
        setBusy(false);
        props.onRewindingChange(false);
      }
    };
    items.push({
      text: "Edit and resend",
      icon: "pencil",
      // The phone's long-press selects text, so a stopped latest prompt also
      // gets a pencil under its bubble.
      inline: target.stoppedLatestRun,
      onPress: () => {
        // Stopped right away and nothing changed on disk: one tap, no questions.
        if (target.skipConfirmation) {
          void perform(false);
          return;
        }
        if (!target.canRestoreFiles) {
          Alert.alert("Edit and resend?", editMessageConfirmationText(target), [
            { text: "Cancel", style: "cancel" },
            {
              text: "Edit and resend",
              onPress: () => {
                void perform(false);
              },
            },
          ]);
          return;
        }
        Alert.alert("Edit and resend?", editMessageConfirmationText(target), [
          { text: "Cancel", style: "cancel" },
          {
            text: "Revert files too",
            style: "destructive",
            onPress: () =>
              Alert.alert("Revert files too?", "Files changed since then will be restored.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Revert files too",
                  style: "destructive",
                  onPress: () => {
                    void perform(true);
                  },
                },
              ]),
          },
          {
            text: "Revert and keep changes",
            onPress: () => {
              void perform(false);
            },
          },
        ]);
      },
    });
  }
  return <MessageMenuContext value={items}>{props.children}</MessageMenuContext>;
}
