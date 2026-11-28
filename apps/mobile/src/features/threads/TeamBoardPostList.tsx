import { LegendList } from "@legendapp/list/react-native";
import {
  formatTeamBoardTime,
  sameTeamBoardListItem,
  teamBoardAddressee,
  teamBoardAddressedMember,
  type TeamBoardMember,
  teamBoardAuthorLine,
  teamBoardAuthorsFromKey,
  teamBoardAuthorsKey,
  type TeamBoardAuthors,
  teamBoardFileLabel,
  teamBoardKind,
  teamBoardOverlapLabel,
  type TeamBoardFilter,
  type TeamBoardKindTone,
  type TeamBoardListItem,
  teamBoardListItems,
  teamBoardRows,
} from "@t3tools/client-runtime/state/team-board";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import type { NodeId, ProviderDriverKind, ServerProvider, TeamBoardPost } from "@t3tools/contracts";
import { createContext, memo, use, useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";

/** Authors by task id, as the lead chat's subagent rows know them; rows compare it by identity. */
export type TeamBoardDrivers = TeamBoardAuthors;

/** The lookup changes only when an author's header fields do, so rows keep their props. */
export function useTeamBoardDrivers(subagents: ReadonlyArray<TeamBoardMember>): TeamBoardDrivers {
  const key = teamBoardAuthorsKey(subagents);
  return useMemo(() => teamBoardAuthorsFromKey(key), [key]);
}

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];
/** The lead chat's providers, and how a post opens its author's chat. */
export const TeamBoardPeople = createContext<{
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly members?: ReadonlyArray<TeamBoardMember>;
  readonly onOpen: ((threadId: string) => void) | null;
}>({ providers: NO_PROVIDERS, onOpen: null });

function useAuthorLine(author: TeamBoardPost["author"], drivers: TeamBoardDrivers) {
  const { providers } = use(TeamBoardPeople);
  const info = author.taskId === undefined ? undefined : drivers.get(author.taskId);
  const provider = providers.find((entry) => entry.instanceId === info?.providerInstanceId);
  const modelLabel =
    info === undefined
      ? null
      : resolveSubagentMetadata({ model: info.model, modelOptions: info.modelOptions, provider })
          .modelLabel;
  return { ...teamBoardAuthorLine(author, info, modelLabel), info, provider };
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
  /** The selected member's name, so posts addressed to it show too. */
  readonly memberName?: string | null;
  readonly emptyText: string;
  readonly drivers: TeamBoardDrivers;
  readonly onReply: ((post: TeamBoardPost) => void) | null;
}) {
  const { posts, filter, taskId, drivers, onReply } = props;
  const memberName = props.memberName ?? undefined;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const onToggle = useCallback(
    (postId: string) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(postId)) next.add(postId);
        return next;
      }),
    [],
  );
  const items = useMemo(
    () =>
      teamBoardListItems(
        teamBoardRows(posts, { filter, taskId, ...(memberName ? { memberName } : {}) }),
        collapsed,
      ),
    [posts, filter, taskId, memberName, collapsed],
  );
  const renderItem = useCallback(
    ({ item }: { item: TeamBoardListItem }) => (
      <TeamBoardListRow item={item} drivers={drivers} onReply={onReply} onToggle={onToggle} />
    ),
    [drivers, onReply, onToggle],
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
  readonly onToggle: (postId: string) => void;
}

/** A thread's first post, or a reply on the thread's line; the last row ends the thread. */
const TeamBoardListRow = memo(
  function TeamBoardListRow({ item, drivers, onReply, onToggle }: TeamBoardListRowProps) {
    if (!item.reply) {
      return (
        <View className={cn(item.endsThread && "border-b border-border-subtle")}>
          <PostRow post={item.post} drivers={drivers} onReply={onReply} />
          {item.hasReplies ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: !item.collapsed }}
              hitSlop={6}
              onPress={() => onToggle(item.post.id)}
              className="ml-[51px] min-h-8 self-start justify-center pr-3 pb-1 active:opacity-60"
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">
                {item.collapsed
                  ? `${item.replyCount} ${item.replyCount === 1 ? "reply" : "replies"}`
                  : "Hide replies"}
              </Text>
            </Pressable>
          ) : null}
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
    previous.onReply === next.onReply &&
    previous.onToggle === next.onToggle,
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
  const { onOpen } = use(TeamBoardPeople);
  const line = useAuthorLine(post.author, props.drivers);
  const open = onOpen === null || line.open === null ? null : () => onOpen(line.open!);
  // A tap opens the sender's chat; a long press replies, as in Messages.
  return (
    <Pressable
      disabled={reply === null && open === null}
      onPress={open ?? undefined}
      onLongPress={reply ? () => reply(post) : undefined}
      accessibilityRole={open ? "button" : undefined}
      accessibilityLabel={open ? `Open ${line.name}` : undefined}
      accessibilityActions={reply ? [{ name: "reply", label: "Reply" }] : undefined}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "reply") reply?.(post);
      }}
      className={cn(
        "flex-row gap-2.5 py-2.5",
        props.nested ? "pr-5 pl-3" : "px-5",
        conflict && "bg-adaptive-amber-500-a10-400-a10",
        (reply || open) && "active:bg-subtle",
      )}
    >
      <TeamBoardAuthorAvatar author={post.author} drivers={props.drivers} />
      <View className="min-w-0 flex-1 gap-1">
        <View className="min-w-0 flex-row items-start gap-1.5">
          {/*
            Sender, "→ addressee" and the tag are separate wrap items at their natural width: the
            tag drops to its own line first, and a title is cut only when its item fills a line.
          */}
          <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <TeamBoardAuthorName author={post.author} drivers={props.drivers} />
            <Addressee post={post} drivers={props.drivers} />
            <View className="flex-row items-center gap-1.5">
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
            </View>
          </View>
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

/** The sender as its row in the lead chat names it: title, then the model's short name. */
export function TeamBoardAuthorName(props: {
  readonly author: TeamBoardPost["author"];
  readonly drivers: TeamBoardDrivers;
}) {
  const line = useAuthorLine(props.author, props.drivers);
  return (
    <View className="min-w-0 max-w-full shrink flex-row items-baseline gap-1">
      {/* Only the title truncates, and only once the name fills a whole line. */}
      <Text numberOfLines={1} className="shrink font-t3-medium text-sm text-foreground">
        {line.name}
      </Text>
      {line.model === null ? null : (
        <Text numberOfLines={1} className="shrink-0 text-xs text-foreground-muted">
          {line.model}
        </Text>
      )}
    </View>
  );
}

export function TeamBoardAuthorAvatar(props: {
  readonly author: TeamBoardPost["author"];
  readonly drivers: TeamBoardDrivers;
  readonly small?: boolean;
}) {
  const line = useAuthorLine(props.author, props.drivers);
  const size = props.small ? "size-[18px]" : "size-[26px]";
  // Same mark as the subagent's row: its instance's own icon. An unknown provider gets a
  // neutral mark, never another provider's.
  const driver: ProviderDriverKind | null = line.provider?.driver ?? line.info?.driver ?? null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={cn("shrink-0 items-center justify-center rounded-full bg-subtle", size)}
    >
      {props.author.user || props.author.taskId === undefined || driver === null ? (
        <SymbolView
          name={
            props.author.user
              ? "person.crop.circle"
              : props.author.taskId === undefined
                ? { ios: "crown.fill", android: "psychology" }
                : { ios: "cpu", android: "build" }
          }
          size={props.small ? 9 : 12}
          tintColorClassName="accent-foreground-muted"
        />
      ) : (
        <ProviderIcon
          provider={driver}
          iconUrl={line.provider?.iconUrl}
          size={props.small ? 10 : 14}
        />
      )}
    </View>
  );
}

/** "→ Sol 6.2", "→ Lead" or "→ You": the addressee's avatar and short model name. */
function Addressee(props: { readonly post: TeamBoardPost; readonly drivers: TeamBoardDrivers }) {
  const { members } = use(TeamBoardPeople);
  const to = teamBoardAddressee(props.post);
  const member =
    to?.kind === "member" && members ? teamBoardAddressedMember(members, props.post) : undefined;
  const author = { name: to?.name ?? "", ...(member ? { taskId: member.id } : {}) };
  const line = useAuthorLine(author, props.drivers);
  if (to === null) return null;
  const name = member ? line.name : to.name;
  return (
    <View
      accessible
      accessibilityLabel={`to ${name}`}
      className="min-w-0 max-w-full shrink flex-row items-center gap-1"
    >
      <Text className="shrink-0 text-xs text-foreground-muted">→</Text>
      {member ? <TeamBoardAuthorAvatar author={author} drivers={props.drivers} small /> : null}
      {member && line.model !== null ? (
        <>
          {/* The title shows when there is room; the model name is never cut. */}
          <Text numberOfLines={1} className="min-w-0 shrink font-t3-medium text-sm text-foreground">
            {name}
          </Text>
          <Text numberOfLines={1} className="shrink-0 text-xs text-foreground-muted">
            {line.model}
          </Text>
        </>
      ) : (
        <Text numberOfLines={1} className="shrink-0 font-t3-medium text-sm text-foreground">
          {name}
        </Text>
      )}
    </View>
  );
}

const MIN_TOUCH = 44;
/**
 * Touch area past a chip's edges so it takes taps across 44 pt without changing how it looks.
 * The ends of a strip have its 20 pt padding to grow into; between chips each side takes at most
 * half the 6 pt gap, so neighbouring touch areas never overlap.
 */
export function teamBoardChipHitSlop(
  width: number,
  index: number,
  count: number,
  vertical: number,
) {
  const need = Math.max(0, MIN_TOUCH - width);
  const leftRoom = index === 0 ? 20 : 3;
  const rightRoom = index === count - 1 ? 20 : 3;
  let left = Math.min(leftRoom, need / 2);
  const right = Math.min(rightRoom, need - left);
  left = Math.min(leftRoom, need - right);
  return { top: vertical, bottom: vertical, left, right };
}
