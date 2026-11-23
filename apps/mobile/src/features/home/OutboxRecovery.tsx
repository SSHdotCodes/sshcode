import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useRef, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useProjects } from "../../state/entities";
import {
  discardRecoveredOutboxMessage,
  recoverOutboxMessage,
  type RecoveryDestination,
} from "../../state/recover-outbox-message";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";
import { useHomeThreadSelection } from "./home-thread-navigation";

/** The outbox owns these messages until a draft is saved or the user discards them. */
export function OutboxRecovery({
  threads,
}: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const queues = useThreadOutboxMessages();
  const messages = useMemo(
    () =>
      Object.values(queues)
        .flat()
        .filter((message) => message.recoveryReason === "missing-thread"),
    [queues],
  );
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const projects = useProjects();
  const navigation = useNavigation();
  const selectThread = useHomeThreadSelection();
  const selected = messages.find((message) => message.messageId === selectedId);
  if (messages.length === 0) return null;

  const restore = async (message: QueuedThreadMessage, destination: RecoveryDestination) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const draftKey = await recoverOutboxMessage(message, destination);
      setOpen(false);
      setSelectedId(null);
      if (destination.kind === "thread") {
        selectThread({ environmentId: destination.environmentId, id: destination.threadId });
      } else {
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: {
            environmentId: String(destination.environmentId),
            projectId: String(destination.projectId),
            draftId: draftKey,
          },
        });
      }
    } catch (error) {
      Alert.alert(
        "Could not restore message",
        error instanceof Error ? error.message : "Your message is still saved.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const discard = (message: QueuedThreadMessage) => {
    Alert.alert("Discard unsent message?", "This also removes its saved attachments.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          if (busyRef.current) return;
          busyRef.current = true;
          setBusy(true);
          void discardRecoveredOutboxMessage(message)
            .then(() => setSelectedId(null))
            .catch((error: unknown) =>
              Alert.alert(
                "Could not discard message",
                error instanceof Error ? error.message : "Try again.",
              ),
            )
            .finally(() => {
              busyRef.current = false;
              setBusy(false);
            });
        },
      },
    ]);
  };
  const close = () => {
    if (!busy) {
      setOpen(false);
      setSelectedId(null);
    }
  };
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${messages.length} unsent ${messages.length === 1 ? "message needs" : "messages need"} attention`}
        onPress={() => setOpen(true)}
        className="mx-4 my-2 rounded-xl bg-subtle px-4 py-3"
      >
        <Text className="font-t3-medium text-foreground">
          {messages.length === 1 ? "Unsent message" : `${messages.length} unsent messages`}
        </Text>
        <Text className="text-sm text-foreground-muted">A chat was removed. Tap to recover.</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <View className="flex-1 items-center justify-center bg-backdrop px-6">
          <ScrollView
            className="max-h-[80%] w-full max-w-md grow-0 rounded-3xl bg-screen"
            contentContainerStyle={{ padding: 20, gap: 12 }}
          >
            <Text accessibilityRole="header" className="text-xl font-t3-semibold">
              {selected ? "Restore message" : "Unsent messages"}
            </Text>
            {selected ? (
              <>
                <Text selectable className="text-foreground-secondary">
                  {selected.text || "Attachment"}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {selected.attachments.length}{" "}
                  {selected.attachments.length === 1 ? "attachment" : "attachments"} kept on this
                  device
                </Text>
                <Text className="font-t3-medium">Restore to an existing chat</Text>
                {threads
                  .filter(
                    (thread) =>
                      thread.environmentId === selected.environmentId &&
                      thread.id !== selected.threadId &&
                      thread.archivedAt === null,
                  )
                  .map((thread) => (
                    <Pressable
                      disabled={busy}
                      key={`${thread.environmentId}:${thread.id}`}
                      accessibilityRole="button"
                      onPress={() =>
                        void restore(selected, {
                          kind: "thread",
                          environmentId: thread.environmentId,
                          threadId: thread.id,
                        })
                      }
                      className="min-h-12 justify-center rounded-xl bg-subtle px-3"
                    >
                      <Text numberOfLines={1}>{thread.title}</Text>
                    </Pressable>
                  ))}
                <Text className="font-t3-medium">Or start a new chat</Text>
                {projects
                  .filter((project) => project.environmentId === selected.environmentId)
                  .map((project) => (
                    <Pressable
                      disabled={busy}
                      key={`${project.environmentId}:${project.id}`}
                      accessibilityRole="button"
                      onPress={() =>
                        void restore(selected, {
                          kind: "new",
                          environmentId: project.environmentId,
                          projectId: project.id,
                        })
                      }
                      className="min-h-12 justify-center rounded-xl bg-subtle px-3"
                    >
                      <Text numberOfLines={1}>{project.title}</Text>
                    </Pressable>
                  ))}
                <Text className="text-sm text-foreground-muted">
                  Connect the original environment if no destinations are available.
                </Text>
                <Pressable
                  disabled={busy}
                  accessibilityRole="button"
                  onPress={() => discard(selected)}
                  className="min-h-12 justify-center"
                >
                  <Text className="text-danger-foreground">Discard message</Text>
                </Pressable>
                <Pressable
                  disabled={busy}
                  accessibilityRole="button"
                  onPress={() => setSelectedId(null)}
                  className="min-h-12 justify-center"
                >
                  <Text>Back</Text>
                </Pressable>
              </>
            ) : (
              messages.map((message) => (
                <Pressable
                  disabled={busy}
                  key={message.messageId}
                  accessibilityRole="button"
                  onPress={() => setSelectedId(message.messageId)}
                  className="min-h-12 justify-center rounded-xl bg-subtle px-3"
                >
                  <Text numberOfLines={2}>{message.text || "Attachment"}</Text>
                  <Text className="text-sm text-foreground-muted">
                    {message.attachments.length}{" "}
                    {message.attachments.length === 1 ? "attachment" : "attachments"}
                  </Text>
                </Pressable>
              ))
            )}
            <Pressable
              disabled={busy}
              accessibilityRole="button"
              onPress={close}
              className="min-h-12 justify-center"
            >
              <Text>Close</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
