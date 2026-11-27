import { pendingThreadSearchJumpAtom } from "@t3tools/client-runtime/state/thread-search";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Option from "effect/Option";

import {
  citedMessageMissing,
  type AssistantCitationChoice,
} from "../lib/assistantCitationSelection";
import { appAtomRegistry } from "../state/atom-registry";
import { useThreadShell } from "../state/entities";
import { useEnvironmentThread } from "../state/threads";
import { useThreadSelection } from "../state/use-thread-selection";
import { AppSheet } from "./AppSheet";
import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { AppText as Text, AppTextInput } from "./AppText";
import { ListSection } from "./ListSection";
import { RowPressable } from "./RowPressable";

/** About six lines of body text; a longer quote scrolls inside its block. */
const QUOTE_MAX_HEIGHT = 6 * 22 + 24;

/**
 * Opens the cited reply in its chat and scrolls to it, loading earlier history and unfolding
 * collapsed turns on the way. Null when the source chat is gone, so the action can hide.
 */
function useShowCitationInChat(citation: AssistantCitation): (() => void) | null {
  const navigation = useNavigation();
  const { selectedThread } = useThreadSelection();
  const shell = useThreadShell(scopeThreadRef(citation.environmentId, citation.threadId));
  // The open chat is already loaded, so a rewound reply can be told apart from one not yet
  // paged in. Another chat is not loaded just to check.
  const current =
    selectedThread?.environmentId === citation.environmentId &&
    selectedThread.id === citation.threadId;
  const thread = useEnvironmentThread(
    current ? citation.environmentId : null,
    current ? citation.threadId : null,
  );
  if (
    shell === null ||
    thread.status === "deleted" ||
    citedMessageMissing(
      Option.getOrNull(thread.data)?.visibleTurnItems ?? null,
      thread.history.hasMoreHistory,
      citation.messageId,
    )
  ) {
    return null;
  }
  return () => {
    appAtomRegistry.set(pendingThreadSearchJumpAtom, {
      environmentId: citation.environmentId,
      threadId: citation.threadId,
      projectId: shell.projectId,
      source: "assistant",
      snippet: "",
      messageCreatedAt: null,
      messageId: citation.messageId,
    });
    if (
      selectedThread?.environmentId !== citation.environmentId ||
      selectedThread.id !== citation.threadId
    ) {
      navigation.navigate("Thread", {
        environmentId: String(citation.environmentId),
        threadId: String(citation.threadId),
      });
    }
  };
}

function SheetAction(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      className="min-h-12 flex-row items-center gap-3 bg-grouped-card px-4 py-3"
    >
      <SymbolView
        name={props.icon}
        size={17}
        tintColorClassName={props.destructive ? "accent-danger-foreground" : "accent-primary"}
        type="monochrome"
      />
      <Text
        className={
          props.destructive ? "text-base text-danger-foreground" : "text-base text-foreground"
        }
      >
        {props.label}
      </Text>
    </RowPressable>
  );
}

/**
 * The cited passage, with its comment and a way back to the reply it came from. A draft's
 * citation can take a comment or be removed; a sent one is read-only. Closing saves the comment.
 */
export function AssistantCitationSheet(props: {
  readonly citation: AssistantCitation;
  readonly onClose: () => void;
  /** Present for a citation still in the draft. Returns false when the comment was not saved. */
  readonly onCommentChange?: (comment: string) => boolean;
  readonly onRemove?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { citation, onCommentChange } = props;
  const [comment, setComment] = useState(citation.comment ?? "");
  const showInChat = useShowCitationInChat(citation);
  const saveComment = () =>
    !onCommentChange || comment.trim() === (citation.comment ?? "") || onCommentChange(comment);
  const close = () => {
    saveComment();
    props.onClose();
  };
  return (
    <AppSheet title="Quote" onClose={close}>
      <ScrollView
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          gap: 20,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        <View className="flex-row gap-3 rounded-2xl bg-grouped-card p-4">
          <View className="w-1 rounded-full bg-primary/60" />
          <ScrollView
            style={{ maxHeight: QUOTE_MAX_HEIGHT }}
            className="min-w-0 flex-1"
            nestedScrollEnabled
          >
            <Text selectable className="text-base leading-[22px] text-foreground-muted">
              {citation.text}
            </Text>
          </ScrollView>
        </View>
        {onCommentChange ? (
          <AppTextInput
            accessibilityLabel="Comment on quote"
            placeholder="Add a comment (optional)"
            multiline
            maxLength={ASSISTANT_CITATION_MAX_COMMENT_LENGTH}
            value={comment}
            onChangeText={setComment}
            className="min-h-24 rounded-2xl bg-grouped-card px-4 py-3 text-base text-foreground"
            style={{ textAlignVertical: "top" }}
          />
        ) : citation.comment ? (
          <View className="rounded-2xl bg-grouped-card px-4 py-3">
            <Text selectable className="text-base text-foreground">
              {citation.comment}
            </Text>
          </View>
        ) : null}
        {showInChat || props.onRemove ? (
          <ListSection separated>
            {showInChat ? (
              <SheetAction
                icon="arrow.up.right"
                label="Show in chat"
                onPress={() => {
                  if (!saveComment()) return;
                  props.onClose();
                  showInChat();
                }}
              />
            ) : null}
            {props.onRemove ? (
              <SheetAction icon="trash" label="Remove" destructive onPress={props.onRemove} />
            ) : null}
          </ListSection>
        ) : null}
      </ScrollView>
    </AppSheet>
  );
}

/** Asked only when a repeated passage's position could not say which copy was selected. */
export function AssistantCitationChooserSheet(props: {
  readonly choices: ReadonlyArray<AssistantCitationChoice>;
  readonly onChoose: (choice: AssistantCitationChoice) => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <AppSheet title="Which passage?" onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          gap: 12,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        <Text className="px-2 text-sm text-foreground-muted">
          This text appears more than once in the reply. Choose the one you selected.
        </Text>
        <ListSection separated>
          {props.choices.map((choice) => (
            <RowPressable
              key={choice.selector.start}
              accessibilityRole="button"
              onPress={() => props.onChoose(choice)}
              className="bg-grouped-card px-4 py-3"
            >
              <Text numberOfLines={3} className="text-base text-foreground-muted">
                {choice.selector.prefix ? `…${choice.selector.prefix.trimStart()}` : ""}
                <Text className="font-t3-medium text-foreground">{choice.selector.text}</Text>
                {choice.selector.suffix ? `${choice.selector.suffix.trimEnd()}…` : ""}
              </Text>
            </RowPressable>
          ))}
        </ListSection>
      </ScrollView>
    </AppSheet>
  );
}

/** A citation in a sent message: two lines of the quote, then the user's comment. */
export function AssistantCitationMessageCard(props: { readonly citation: AssistantCitation }) {
  const [open, setOpen] = useState(false);
  const { citation } = props;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Quote: ${citation.text}${citation.comment ? `. Comment: ${citation.comment}` : ""}`}
        accessibilityHint="Opens the quote"
        onPress={() => setOpen(true)}
        // Stretches with the bubble; the excerpt's own width lets the bubble grow to its max.
        className="gap-1 rounded-[12px] bg-user-bubble-foreground/10 px-3 py-2"
      >
        <View className="flex-row gap-2">
          <SymbolView
            name="text.quote"
            size={13}
            tintColorClassName="accent-user-bubble-foreground-muted"
            type="monochrome"
            style={{ marginTop: 3 }}
          />
          <Text
            numberOfLines={2}
            className="min-w-0 shrink text-sm text-user-bubble-foreground-muted"
          >
            {citation.text.replace(/\s+/g, " ").trim()}
          </Text>
        </View>
        {citation.comment ? (
          <Text className="text-base text-user-bubble-foreground">{citation.comment}</Text>
        ) : null}
      </Pressable>
      {open ? <AssistantCitationSheet citation={citation} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
