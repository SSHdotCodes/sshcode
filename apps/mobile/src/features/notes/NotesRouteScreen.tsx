import { DefaultHarnessMascot } from "../../components/DefaultHarnessMascot";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { NoteId, type EnvironmentId, type Note, type NoteOperation } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useCallback, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  useWindowDimensions,
  Platform,
  Pressable,
  TextInput,
  View,
  type ViewInstance,
  type TextInputInstance,
} from "react-native";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { uuidv4 } from "../../lib/uuid";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useWorkspaceState } from "../../state/workspace";

function IdeaRow({
  item,
  canEdit,
  mutate,
  startChat,
}: {
  readonly item: Note;
  readonly canEdit: boolean;
  readonly mutate: (operation: NoteOperation) => Promise<boolean>;
  readonly startChat: (text: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  // Return dismisses the keyboard, so submit and blur both fire for one edit;
  // the second call must not send the same text again.
  const saving = useRef(false);
  const save = async () => {
    if (saving.current) return;
    const submitted = text;
    const trimmed = submitted?.trim();
    if (!trimmed) {
      setText(null);
      return;
    }
    saving.current = true;
    try {
      if (
        trimmed === item.text ||
        (await mutate({ type: "updateText", id: item.id, text: trimmed }))
      ) {
        setText((current) => (current === submitted ? null : current));
      }
    } finally {
      saving.current = false;
    }
  };
  return (
    <ReanimatedSwipeable
      enabled={canEdit}
      overshootRight={false}
      renderRightActions={() => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete ${item.text}`}
          onPress={() => void mutate({ type: "delete", id: item.id })}
          className="w-20 items-center justify-center bg-danger"
        >
          <SymbolView name="trash" size={20} tintColorClassName="accent-danger-foreground" />
          <Text className="mt-1 text-xs text-danger-foreground">Delete</Text>
        </Pressable>
      )}
    >
      {/* Opaque, like the rest of the sheet: the row slides over the delete
          action and must not let it show through. */}
      <View className="min-h-16 flex-row items-center border-b border-border bg-sheet-solid px-3">
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={item.text}
          accessibilityState={{ checked: item.done, disabled: !canEdit }}
          disabled={!canEdit}
          className="h-[44px] w-[44px] items-center justify-center"
          onPress={() => {
            void Haptics.selectionAsync();
            void mutate({ type: "setDone", id: item.id, done: !item.done });
          }}
        >
          <SymbolView
            name={item.done ? "checkmark.circle.fill" : "circle"}
            size={25}
            tintColorClassName={item.done ? "accent-primary" : "accent-icon-subtle"}
          />
        </Pressable>
        <TextInput
          accessibilityLabel="Idea text"
          editable={canEdit}
          value={text ?? item.text}
          maxLength={10_000}
          className={cn(
            "min-h-13 min-w-0 flex-1 py-3 font-sans text-base text-foreground",
            item.done && "text-foreground-muted line-through",
          )}
          selectionColorClassName="accent-focus/32"
          returnKeyType="done"
          onChangeText={setText}
          onBlur={() => void save()}
          onSubmitEditing={() => void save()}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start a chat"
          disabled={!canEdit}
          onPress={() => startChat(text?.trim() || item.text)}
          className="h-[44px] w-[44px] items-center justify-center disabled:opacity-50"
        >
          <SymbolView name="square.and.pencil" size={20} tintColorClassName="accent-icon" />
        </Pressable>
      </View>
    </ReanimatedSwipeable>
  );
}

function EnvironmentNotes({
  environmentId,
  connected,
  environmentPicker,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly environmentPicker: React.ReactNode;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const emptyStateRef = useRef<ViewInstance>(null);
  const [emptyVisible, setEmptyVisible] = useState(false);
  const measureEmptyState = useCallback(() => {
    emptyStateRef.current?.measureInWindow((_x, y, _width, height) =>
      setEmptyVisible(y + height > 0 && y < windowHeight),
    );
  }, [windowHeight]);
  const query = useEnvironmentQuery(serverEnvironment.notesState({ environmentId, input: {} }));
  const permission = useAtomValue(serverEnvironment.mutateNotes.permissionAtom(environmentId));
  const canEdit = permission && connected && query.isSuccess;
  const runMutation = useAtomCommand(serverEnvironment.mutateNotes, { reportFailure: false });
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const inputRef = useRef<TextInputInstance>(null);
  const startingChat = useRef(false);
  const items = query.data?.items ?? [];
  // The notes subscription stays open, so it never stops "waiting": it has
  // loaded once its first state has arrived. Offline nothing is on its way,
  // so that is not loading; the header already says to reconnect.
  const loading = connected && query.data === null && query.error === null;
  const offlineWithoutIdeas = !connected && query.data === null;
  const active = items.filter((item) => !item.done);
  const done = items.filter((item) => item.done);
  const mutate = async (operation: NoteOperation) => {
    const result = await runMutation({ environmentId, input: operation });
    if (result._tag === "Success") {
      setError(null);
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not save this idea.");
    }
    return false;
  };
  const capture = async () => {
    const idea = text.trim();
    if (!idea || !canEdit) return;
    setText("");
    inputRef.current?.focus();
    if (!(await mutate({ type: "add", id: NoteId.make(uuidv4()), text: idea }))) {
      setText((current) => (current ? `${idea}\n${current}` : idea));
    }
  };
  const startChat = async (idea: string) => {
    if (startingChat.current) return;
    startingChat.current = true;
    try {
      await waitForComposerDraftsLoaded();
      const project = await openScratch({ environmentId, input: {} });
      if (project._tag === "Failure") {
        if (!isAtomCommandInterrupted(project)) {
          const cause = squashAtomCommandFailure(project);
          Alert.alert(
            "Could not start a chat",
            cause instanceof Error ? cause.message : "Please try again.",
          );
        }
        return;
      }
      const draftId = createNewTaskDraft({ environmentId, projectId: project.value.id });
      setComposerDraftText(draftId, idea);
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: { draftId, title: project.value.title },
      });
    } catch (cause) {
      Alert.alert(
        "Could not start a chat",
        cause instanceof Error ? cause.message : "Please try again.",
      );
    } finally {
      startingChat.current = false;
    }
  };
  const renderIdea = (item: Note) => (
    <IdeaRow
      key={item.id}
      item={item}
      canEdit={canEdit}
      mutate={mutate}
      startChat={(idea) => void startChat(idea)}
    />
  );
  const list = (
    <FlatList
      onScroll={measureEmptyState}
      scrollEventThrottle={100}
      data={active}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => renderIdea(item)}
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      stickyHeaderIndices={[0]}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      ListHeaderComponent={
        // Sticky: rows scroll underneath, so the surface has to be opaque.
        <View className="gap-3 bg-sheet-solid px-4 pb-3 pt-3">
          {environmentPicker}
          <AppTextInput
            ref={inputRef}
            accessibilityLabel="Add an idea"
            placeholder="Add an idea…"
            maxLength={10_000}
            value={text}
            onChangeText={setText}
            editable={canEdit}
            returnKeyType="done"
            submitBehavior="submit"
            onSubmitEditing={() => void capture()}
          />
          {error || query.error ? (
            <Text accessibilityRole="alert" className="text-sm text-danger">
              {error ?? query.error}
            </Text>
          ) : null}
          {!connected ? (
            <Text className="text-sm text-foreground-muted">Reconnect to sync your ideas.</Text>
          ) : null}
          {connected && !permission ? (
            <Text className="text-sm text-foreground-muted">
              This connection has read-only access to notes.
            </Text>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        offlineWithoutIdeas ? undefined : (
          <View
            ref={emptyStateRef}
            onLayout={measureEmptyState}
            className="items-center gap-2 px-5 py-6"
          >
            {!loading ? (
              <DefaultHarnessMascot
                environmentId={environmentId}
                state="idea"
                visible={emptyVisible}
              />
            ) : null}
            <Text className="text-foreground-muted">
              {loading ? "Loading ideas…" : "A little space for your next idea."}
            </Text>
          </View>
        )
      }
      ListFooterComponent={
        done.length > 0 ? (
          <View className="mt-6">
            <View className="flex-row items-center justify-between px-4">
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: doneOpen }}
                accessibilityLabel={`Done (${done.length})`}
                onPress={() => setDoneOpen((open) => !open)}
                className="min-h-[44px] flex-row items-center gap-2"
              >
                <SymbolView
                  name={doneOpen ? "chevron.down" : "chevron.right"}
                  size={12}
                  tintColorClassName="accent-icon"
                />
                <Text className="font-t3-medium">Done ({done.length})</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={!canEdit}
                onPress={() => void mutate({ type: "clearDone" })}
                className="min-h-[44px] justify-center px-2 disabled:opacity-50"
              >
                <Text className="text-primary">Clear done</Text>
              </Pressable>
            </View>
            {doneOpen ? done.map(renderIdea) : null}
          </View>
        ) : undefined
      }
    />
  );
  return Platform.OS === "ios" ? (
    <NativeScrollViewMarker style={{ flex: 1 }}>{list}</NativeScrollViewMarker>
  ) : (
    list
  );
}

export function NotesRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId?: string } | undefined>) {
  const navigation = useNavigation();
  const { environments } = useWorkspaceState();
  const [selected, setSelected] = useState(route.params?.environmentId ?? null);
  const environment =
    environments.find((entry) => entry.environmentId === selected) ??
    environments.find((entry) => entry.connectionState === "connected") ??
    environments[0];
  if (selected === null && environment) setSelected(environment.environmentId);
  const picker =
    environments.length > 1 ? (
      <ControlPillMenu
        title="Notes environment"
        actions={environments.map((entry) => ({
          id: entry.environmentId,
          title: entry.environmentLabel,
          state: entry.environmentId === environment?.environmentId ? "on" : "off",
        }))}
        onPressAction={({ nativeEvent }) => setSelected(nativeEvent.event)}
      >
        <ControlPill
          variant="pill"
          label={environment?.environmentLabel ?? "Environment"}
          icon="chevron.down"
        />
      </ControlPillMenu>
    ) : null;
  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title="Notes" onBack={() => navigation.goBack()} />
      ) : null}
      {environment ? (
        <EnvironmentNotes
          key={environment.environmentId}
          environmentId={environment.environmentId}
          connected={environment.connectionState === "connected"}
          environmentPicker={picker}
        />
      ) : (
        <Text className="p-5 text-foreground-muted">
          Connect to an environment to keep your ideas in sync.
        </Text>
      )}
    </View>
  );
}
