import { LegendList } from "@legendapp/list/react-native";
import {
  formatTeamBoardTime,
  sameTeamBoardListItem,
  teamBoardDriversFromKey,
  teamBoardDriversKey,
  teamBoardFileLabel,
  teamBoardKind,
  teamBoardOverlapLabel,
  type TeamBoardFilter,
  type TeamBoardKindTone,
  type TeamBoardListItem,
  teamBoardListItems,
  teamBoardRows,
} from "@t3tools/client-runtime/state/team-board";
import type {
  NodeId,
  OrchestrationV2Subagent,
  ProviderDriverKind,
  TeamBoardPost,
} from "@t3tools/contracts";
import { memo, useCallback, useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { getProviderClient } from "../../lib/providerClients";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** Authors' providers by task id; rows compare it by identity. */
export type TeamBoardDrivers = ReadonlyMap<string, ProviderDriverKind>;

/** The lookup changes only when an author's provider does, so rows keep their props. */
export function useTeamBoardDrivers(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
): TeamBoardDrivers {
  const key = teamBoardDriversKey(subagents);
  return useMemo(() => teamBoardDriversFromKey(key), [key]);
}

const KIND_CHIP: Record<TeamBoardKindTone, { readonly box: string; readonly text: string }> = {
  claim: { box: "bg-adaptive-blue-50-blue-400-a14", text: "text-adaptive-blue-600-400" },
  finding: { box: "bg-adaptive-violet-500-a12-a16", text: "text-adaptive-violet-700-300" },
  question: { box: "bg-adaptive-amber-500-a12-a16", text: "text-adaptive-amber-700-300" },
  done: { box: "bg-adaptive-emerald-500-a12-a16", text: "text-adaptive-emerald-700-300" },
  muted: { box: "bg-subtle", text: "text-foreground-muted" },
  decision: { box: "bg-adaptive-neutral-950-a10-white-a10", text: "text-foreground" },
};

const itemKey = (item: TeamBoardListItem) => item.post.id;
const itemType = (item: TeamBoardListItem) => (item.reply ? "reply" : "post");

/**
 * Posts as threads, newest first, in a virtualized list with one row per post: only rows near
 * the screen mount, even in a thread with hundreds of replies, and a delta frame re-renders only
 * the rows it touched.
 */
export function TeamBoardPostList(props: {
  readonly posts: ReadonlyArray<TeamBoardPost>;
  readonly filter: TeamBoardFilter;
  readonly taskId: NodeId | null;
  readonly emptyText: string;
  readonly drivers: TeamBoardDrivers;
  readonly onReply: ((post: TeamBoardPost) => void) | null;
}) {
  const { posts, filter, taskId, drivers, onReply } = props;
  const items = useMemo(
    () => teamBoardListItems(teamBoardRows(posts, { filter, taskId })),
    [posts, filter, taskId],
  );
  const renderItem = useCallback(
    ({ item }: { item: TeamBoardListItem }) => (
      <TeamBoardListRow item={item} drivers={drivers} onReply={onReply} />
    ),
    [drivers, onReply],
  );
  return (
    <LegendList
      className="flex-1"
      data={items}
      renderItem={renderItem}
      extraData={renderItem}
      keyExtractor={itemKey}
      getItemType={itemType}
      estimatedItemSize={84}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 16 }}
      ListEmptyComponent={
        <Text className="px-5 py-6 text-center text-sm text-foreground-muted">
          {props.emptyText}
        </Text>
      }
    />
  );
}

interface TeamBoardListRowProps {
  readonly item: TeamBoardListItem;
  readonly drivers: TeamBoardDrivers;
  readonly onReply: ((post: TeamBoardPost) => void) | null;
}

/** A thread's first post, or a reply on the thread's line; the last row ends the thread. */
const TeamBoardListRow = memo(
  function TeamBoardListRow({ item, drivers, onReply }: TeamBoardListRowProps) {
    if (!item.reply) {
      return (
        <View className={cn(item.endsThread && "border-b border-border-subtle")}>
          <PostRow post={item.post} drivers={drivers} onReply={onReply} />
        </View>
      );
    }
    // Consecutive reply rows join their left borders into one connecting line.
    return (
      <View className={cn(item.endsThread && "border-b border-border-subtle pb-2")}>
        <View className="ml-[51px] border-s border-border">
          <PostRow post={item.post} drivers={drivers} onReply={null} nested />
        </View>
      </View>
    );
  },
  (previous: TeamBoardListRowProps, next: TeamBoardListRowProps) =>
    sameTeamBoardListItem(previous.item, next.item) &&
    previous.drivers === next.drivers &&
    previous.onReply === next.onReply,
);

function PostRow(props: {
  readonly post: TeamBoardPost;
  readonly drivers: TeamBoardDrivers;
  readonly onReply: ((post: TeamBoardPost) => void) | null;
  readonly nested?: boolean;
}) {
  const { post } = props;
  const kind = teamBoardKind(post.kind);
  const conflict = post.conflict;
  const chips = [
    ...(post.commit ? [post.commit] : []),
    ...(post.files ?? []).map((file) => {
      const label = teamBoardFileLabel(file);
      return label.symbol ? `${label.name}#${label.symbol}` : label.name;
    }),
  ];
  const reply = props.onReply;
  // Long-press replies, as in Messages; rows stay as the design draws them.
  return (
    <Pressable
      disabled={reply === null}
      onLongPress={reply ? () => reply(post) : undefined}
      accessibilityActions={reply ? [{ name: "reply", label: "Reply" }] : undefined}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "reply") reply?.(post);
      }}
      className={cn(
        "flex-row gap-2.5 py-2.5",
        props.nested ? "pr-5 pl-3" : "px-5",
        conflict && "bg-adaptive-amber-500-a10-400-a10",
        reply && "active:bg-subtle",
      )}
    >
      <TeamBoardAuthorAvatar author={post.author} drivers={props.drivers} />
      <View className="min-w-0 flex-1 gap-1">
        <View className="min-w-0 flex-row items-center gap-1.5">
          <TeamBoardAuthorName author={post.author} drivers={props.drivers} />
          {post.to ? (
            <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
              to {post.to}
            </Text>
          ) : null}
          {kind ? (
            <View className={cn("rounded-md px-1.5 py-px", KIND_CHIP[kind.tone].box)}>
              <Text className={cn("text-xs font-t3-medium", KIND_CHIP[kind.tone].text)}>
                {kind.label}
              </Text>
            </View>
          ) : null}
          {post.pinned ? (
            <SymbolView
              name="pin.fill"
              size={10}
              tintColorClassName="accent-foreground-muted"
              accessibilityLabel="Pinned"
            />
          ) : null}
          <View className="flex-1" />
          <Text className="shrink-0 text-xs text-foreground-muted">
            {formatTeamBoardTime(post.at)}
          </Text>
        </View>
        <Text className="text-base leading-normal text-foreground">{post.text}</Text>
        {conflict ? (
          <Text className="text-xs text-adaptive-amber-700-400">
            {teamBoardOverlapLabel(conflict)}
          </Text>
        ) : null}
        {chips.length > 0 ? (
          <View className="flex-row flex-wrap gap-1">
            {chips.map((chip) => (
              <View key={chip} className="rounded-md bg-subtle px-1.5 py-px">
                <Text numberOfLines={1} className="font-mono text-xs text-foreground-muted">
                  {chip}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** The color a subagent's card shows for its provider; null reads in the text color. */
function providerColor(driver: ProviderDriverKind, dark: boolean): string | null {
  if (driver === "claudeAgent") return "#D97757";
  if (driver === "antigravity") return "#5B87BF";
  const fill = getProviderClient(driver)?.icon?.fill;
  return fill ? (dark ? fill.dark : fill.light) : null;
}

export function TeamBoardAuthorName(props: {
  readonly author: TeamBoardPost["author"];
  readonly drivers: TeamBoardDrivers;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const driver =
    props.author.taskId === undefined ? undefined : props.drivers.get(props.author.taskId);
  const color = driver ? providerColor(driver, themeAppearance === "dark") : null;
  return (
    <Text
      numberOfLines={1}
      className="shrink font-t3-medium text-sm text-foreground"
      style={color ? { color } : undefined}
    >
      {props.author.user ? "You" : props.author.name}
    </Text>
  );
}

export function TeamBoardAuthorAvatar(props: {
  readonly author: TeamBoardPost["author"];
  readonly drivers: TeamBoardDrivers;
  readonly small?: boolean;
}) {
  const size = props.small ? "size-[18px]" : "size-[26px]";
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={cn("shrink-0 items-center justify-center rounded-full bg-subtle", size)}
    >
      {props.author.user || props.author.taskId === undefined ? (
        <SymbolView
          name={
            props.author.user ? "person.crop.circle" : { ios: "crown.fill", android: "psychology" }
          }
          size={props.small ? 9 : 12}
          tintColorClassName="accent-foreground-muted"
        />
      ) : (
        <ProviderIcon
          provider={props.drivers.get(props.author.taskId) ?? null}
          size={props.small ? 10 : 14}
        />
      )}
    </View>
  );
}
