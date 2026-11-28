import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import { StackActions, type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  teamBoardHoldsLabel,
  teamBoardRepoLatestPostId,
  teamBoardRoster,
  type TeamBoardMemberState,
  type TeamBoardRosterChip,
  formatTeamBoardMembers,
  formatTeamBoardPushTime,
  formatTeamBoardRanges,
  parseTeamBoardDraft,
  TEAM_BOARD_FILTERS,
  teamBoardAuthorKey,
  teamBoardDraftError,
  teamBoardFileLabel,
  teamBoardFiles,
  type TeamBoardFilter,
} from "@t3tools/client-runtime/state/team-board";
import type {
  EnvironmentId,
  NodeId,
  ScopedThreadRef,
  TeamBoardFile,
  TeamBoardPost,
  TeamBoardPush,
  ThreadId,
} from "@t3tools/contracts";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { uuidv4 } from "../../lib/uuid";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPill } from "../../components/ControlPill";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { SegmentedControl } from "../../components/SegmentedControl";
import { cn } from "../../lib/cn";
import { useEnvironmentServerConfig } from "../../state/entities";
import { teamBoardEnvironment } from "../../state/teamBoard";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  TeamBoardAuthorAvatar,
  TeamBoardAuthorName,
  type TeamBoardDrivers,
  TeamBoardPeople,
  TeamBoardPostList,
  useTeamBoardDrivers,
  teamBoardChipHitSlop,
} from "./TeamBoardPostList";

type BoardTarget = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Opened from a subagent card: the board filtered to that subagent. */
  readonly taskId?: NodeId | null;
  /** Opened from the header: past pushes, read-only, even while a new push runs. */
  readonly history?: boolean;
};

/** The live push, the list of past pushes, or one past push. */
type SheetView =
  | { readonly kind: "live" }
  | { readonly kind: "history" }
  | { readonly kind: "push"; readonly push: TeamBoardPush };

/** The lead's team board: posts and the overlap map, newest first, with a team composer. */
export function ThreadTeamBoardSheet({ route }: StaticScreenProps<BoardTarget>) {
  const target = route.params;
  const ref = scopeThreadRef(target.environmentId, target.threadId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<SheetView>(
    target.history ? { kind: "history" } : { kind: "live" },
  );
  const close = () => navigation.goBack();
  // The keyboard covers the home indicator, so the composer sits right on it.
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const bottomInset = keyboardVisible ? 8 : Math.max(insets.bottom, 12);
  const headerTop = Platform.OS === "android" ? insets.top + 12 : 18;
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        {view.kind === "history" ? (
          <PushHistory
            boardRef={ref}
            headerTop={headerTop}
            bottomInset={bottomInset}
            onOpen={(push) => setView({ kind: "push", push })}
            onClose={close}
          />
        ) : (
          <BoardView
            key={view.kind === "push" ? view.push.id : "live"}
            target={target}
            boardRef={ref}
            push={view.kind === "push" ? view.push : null}
            headerTop={headerTop}
            bottomInset={bottomInset}
            onBack={view.kind === "push" ? () => setView({ kind: "history" }) : null}
            onClose={close}
          />
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

function SheetHeader(props: {
  readonly top: number;
  readonly subtitle: string | null;
  readonly onBack: (() => void) | null;
  readonly onClose: () => void;
  /** Live boards pass their chat, so two or more live repositories show a picker. */
  readonly liveRef?: ScopedThreadRef;
}) {
  return (
    <View className="flex-row items-center gap-3 px-5 pb-2" style={{ paddingTop: props.top }}>
      {props.onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Past pushes"
          hitSlop={8}
          onPress={props.onBack}
          className="h-8 w-8 items-center justify-center rounded-full bg-subtle active:opacity-60"
        >
          <SymbolView
            name="chevron.left"
            size={13}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        </Pressable>
      ) : null}
      <View className="min-w-0 flex-1 gap-0.5">
        {props.liveRef ? (
          <RepoTitle boardRef={props.liveRef} />
        ) : (
          <Text className="text-lg font-t3-bold text-foreground">Team board</Text>
        )}
        {props.subtitle ? (
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close team board"
        hitSlop={8}
        onPress={props.onClose}
        className="h-8 w-8 items-center justify-center rounded-full bg-subtle active:opacity-60"
      >
        <SymbolView name="xmark" size={13} tintColorClassName="accent-icon" type="monochrome" />
      </Pressable>
    </View>
  );
}

/** "Team board · sshcode ▾" with two or more live repositories; a native menu picks one. */
function RepoTitle(props: { readonly boardRef: ScopedThreadRef }) {
  const choice = useAtomValue(teamBoardEnvironment.repoChoiceAtom(props.boardRef));
  const pick = useAtomSet(teamBoardEnvironment.pickedRepoAtom(props.boardRef));
  if (choice === null) {
    return <Text className="text-lg font-t3-bold text-foreground">Team board</Text>;
  }
  return (
    <ControlPillMenu
      accessible
      accessibilityLabel={`Team board for ${choice.chosen.name}. Choose a repository.`}
      accessibilityRole="button"
      actions={choice.repos.map((repo) => ({
        id: repo.id,
        title: repo.name,
        state: repo.id === choice.chosen.id ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => pick(nativeEvent.event)}
    >
      <Pressable className="min-w-0 flex-row items-center gap-1.5 self-start active:opacity-60">
        <Text numberOfLines={1} className="shrink text-lg font-t3-bold text-foreground">
          Team board
          <Text className="text-lg font-t3-medium text-foreground-muted">
            {` · ${choice.chosen.name}`}
          </Text>
        </Text>
        <SymbolView
          name="chevron.down"
          size={12}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      </Pressable>
    </ControlPillMenu>
  );
}

const pushKey = (push: TeamBoardPush) => push.id;

/** Past pushes, newest first: when each ran and who was on the team. */
function PushHistory(props: {
  readonly boardRef: ScopedThreadRef;
  readonly headerTop: number;
  readonly bottomInset: number;
  readonly onOpen: (push: TeamBoardPush) => void;
  readonly onClose: () => void;
}) {
  const historyAtom = teamBoardEnvironment.historyListAtom(props.boardRef);
  const history = useAtomValue(historyAtom);
  const loadOlder = useAtomSet(historyAtom);
  const olderCursor = history.olderCursor;
  const { onOpen } = props;
  const renderItem = useCallback(
    ({ item }: { item: TeamBoardPush }) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${formatTeamBoardMembers(item.members)}, ${formatTeamBoardPushTime(item)}`}
        onPress={() => onOpen(item)}
        className="flex-row items-center gap-3 border-b border-border-subtle px-5 py-3 active:bg-subtle"
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-base text-foreground">
            {formatTeamBoardMembers(item.members)}
          </Text>
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {formatTeamBoardPushTime(item)}
          </Text>
        </View>
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-foreground-muted" />
      </Pressable>
    ),
    [onOpen],
  );
  return (
    <>
      <SheetHeader
        top={props.headerTop}
        subtitle="Past pushes · read-only"
        onBack={null}
        onClose={props.onClose}
      />
      <LegendList
        className="flex-1"
        data={history.pushes}
        renderItem={renderItem}
        keyExtractor={pushKey}
        estimatedItemSize={64}
        contentContainerStyle={{ paddingBottom: props.bottomInset }}
        ListEmptyComponent={
          history.loading ? null : (
            <Text className="px-5 py-6 text-center text-sm text-foreground-muted">
              No past pushes.
            </Text>
          )
        }
        ListFooterComponent={
          history.loading ? (
            <View className="flex-row items-center gap-2 px-5 py-3">
              <AppActivityIndicator size="small" />
              <Text className="text-sm text-foreground-muted">Loading older pushes…</Text>
            </View>
          ) : olderCursor !== null ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => loadOlder(olderCursor)}
              className="min-h-11 items-center justify-center px-5 active:opacity-60"
            >
              <Text className="text-sm font-t3-medium text-foreground">Older pushes</Text>
            </Pressable>
          ) : null
        }
      />
    </>
  );
}

/** The live push's board, or a past push's, which is read-only and never marks read. */
function BoardView(props: {
  readonly target: BoardTarget;
  readonly boardRef: ScopedThreadRef;
  readonly push: TeamBoardPush | null;
  readonly headerTop: number;
  readonly bottomInset: number;
  readonly onBack: (() => void) | null;
  readonly onClose: () => void;
}) {
  const ref = props.boardRef;
  const live = props.push === null;
  const details = useAtomValue(
    props.push === null
      ? teamBoardEnvironment.detailsAtom(ref)
      : teamBoardEnvironment.pushAtom(ref, props.push.id),
  );
  const setSeen = useAtomSet(teamBoardEnvironment.seenAtom(ref));
  const canPost = useAtomValue(teamBoardEnvironment.permissionAtom(ref.environmentId));
  // The chat's task records, or the QA fixture's stand-ins.
  const subagents = useAtomValue(teamBoardEnvironment.membersAtom(ref));
  const drivers = useTeamBoardDrivers(subagents);
  const holds = useAtomValue(teamBoardEnvironment.holdsAtom(ref));
  const providers = useEnvironmentServerConfig(ref.environmentId)?.providers;
  const navigation = useNavigation();
  // A post opens its sender's chat: the sheet closes and the chat is pushed, like a subagent row.
  const people = useMemo(
    () => ({
      providers: providers ?? [],
      members: subagents,
      onOpen: (threadId: string) => {
        navigation.goBack();
        navigation.dispatch(
          StackActions.push("Thread", { environmentId: String(ref.environmentId), threadId }),
        );
      },
    }),
    [navigation, providers, ref.environmentId, subagents],
  );
  const [tab, setTab] = useState<"posts" | "files">("posts");
  const [filter, setFilter] = useState<TeamBoardFilter>("all");
  const [taskId, setTaskId] = useState<NodeId | null>(live ? (props.target.taskId ?? null) : null);
  const summary = useAtomValue(teamBoardEnvironment.summaryAtom(ref));
  const choice = useAtomValue(teamBoardEnvironment.repoChoiceAtom(ref));
  const repo = live ? (choice?.chosen.id ?? null) : null;
  // A reply belongs to the repository it was picked in.
  const [replyState, setReplyState] = useState<{
    readonly repo: string | null;
    readonly post: TeamBoardPost;
  } | null>(null);
  const replyTo = replyState?.repo === repo ? replyState.post : null;
  const setReplyTo = useCallback(
    (post: TeamBoardPost | null) => setReplyState(post === null ? null : { repo, post }),
    [repo],
  );
  // Reading a repository marks only its newest post seen; the dot stays while another has news.
  const latestPostId = live ? teamBoardRepoLatestPostId(summary, repo) : undefined;
  // Reading the live board marks it read on this phone, including posts that land while open.
  useEffect(() => {
    if (latestPostId !== undefined) setSeen({ latestPostId, repo });
  }, [latestPostId, repo, setSeen]);
  const agentName =
    taskId === null
      ? null
      : subagents.find((entry) => entry.id === taskId)?.title?.trim() ||
        details?.posts?.find((post) => post.author.taskId === taskId)?.author.name ||
        "Subagent";
  const writable = live && details?.active === true;
  const subtitle =
    props.push !== null
      ? formatTeamBoardPushTime(props.push)
      : details !== null && !details.active
        ? "Ended · read-only"
        : null;

  return (
    <TeamBoardPeople value={people}>
      <SheetHeader
        top={props.headerTop}
        subtitle={subtitle}
        onBack={props.onBack}
        onClose={props.onClose}
        {...(live ? { liveRef: ref } : {})}
      />
      <View className="px-5 pb-2">
        <SegmentedControl
          role="tab"
          size="compact"
          options={[
            { value: "posts", label: "Posts" },
            { value: "files", label: "Files" },
          ]}
          selected={tab}
          onSelect={setTab}
        />
      </View>
      <RosterRow
        holds={holds}
        roster={teamBoardRoster(subagents, details)}
        selected={taskId}
        drivers={drivers}
        onSelect={setTaskId}
      />
      {details === null ? (
        <View className="flex-1 flex-row items-start gap-2 px-5 pt-4">
          <AppActivityIndicator size="small" />
          <Text className="text-sm text-foreground-muted">Loading the board…</Text>
        </View>
      ) : tab === "posts" ? (
        <>
          <FilterChips filter={filter} onFilterChange={setFilter} />
          <TeamBoardPostList
            posts={details.posts ?? EMPTY_POSTS}
            filter={filter}
            taskId={taskId}
            memberName={agentName}
            emptyText={
              agentName !== null && filter === "all"
                ? `No posts from ${agentName} yet.`
                : "Nothing here yet."
            }
            drivers={drivers}
            onReply={writable && canPost ? setReplyTo : null}
          />
        </>
      ) : (
        <FilesList
          files={teamBoardFiles(details.files ?? [], taskId)}
          agentName={agentName}
          drivers={drivers}
        />
      )}
      {writable ? (
        <TeamComposer
          environmentId={props.target.environmentId}
          threadId={props.target.threadId}
          repo={repo}
          canPost={canPost}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          bottomInset={props.bottomInset}
        />
      ) : (
        <View style={{ height: props.bottomInset }} />
      )}
    </TeamBoardPeople>
  );
}

const EMPTY_POSTS: ReadonlyArray<TeamBoardPost> = [];

const STATE_DOT: Record<TeamBoardMemberState, string> = {
  working: "bg-adaptive-sky-600-400",
  done: "bg-adaptive-emerald-600-400",
  failed: "bg-adaptive-rose-600-400",
};

/** One chip per member; tapping one filters Posts and Files to it, tapping it again clears. */
function RosterRow(props: {
  readonly roster: ReadonlyArray<TeamBoardRosterChip>;
  readonly selected: NodeId | null;
  readonly drivers: TeamBoardDrivers;
  readonly onSelect: (taskId: NodeId | null) => void;
  /** Files each member holds now, from the presence feed (live frames carry no presence). */
  readonly holds?: ReadonlyMap<string, number>;
}) {
  if (props.roster.length === 0) return null;
  return (
    // The strip's own padding takes each chip's touch area to 44 pt without reaching the filters.
    <ChipStrip
      accessibilityLabel="Team"
      className="mb-0.5"
      contentContainerClassName="gap-1.5 px-5 py-1"
    >
      {props.roster.map((chip, index) => {
        const selected = props.selected === chip.member.id;
        const detail = teamBoardHoldsLabel(props.holds?.get(chip.member.id) ?? chip.holds);
        return (
          <ChipPressable
            key={chip.member.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={[chip.name, chip.state, detail].filter(Boolean).join(", ")}
            accessibilityHint={selected ? "Shows everyone" : "Shows only this subagent"}
            onPress={() => props.onSelect(selected ? null : chip.member.id)}
            index={index}
            count={props.roster.length}
            vertical={4}
            className={cn(
              "min-h-9 max-w-[300px] flex-row items-center gap-1.5 rounded-full border px-2 py-1 active:opacity-70",
              selected ? "border-border bg-subtle-strong" : "border-border-subtle bg-subtle",
            )}
          >
            <View>
              <TeamBoardAuthorAvatar
                author={{ name: chip.name, taskId: chip.member.id }}
                drivers={props.drivers}
                small
              />
              <View
                className={cn(
                  "absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-sheet",
                  STATE_DOT[chip.state],
                )}
              />
            </View>
            <Text
              numberOfLines={1}
              className="max-w-[140px] font-t3-medium text-xs text-foreground"
            >
              {chip.name}
            </Text>
            {detail ? (
              <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
                {detail}
              </Text>
            ) : null}
          </ChipPressable>
        );
      })}
    </ChipStrip>
  );
}

/** A strip chip whose touch area reaches 44 pt wide and tall without overlapping its neighbours. */
function ChipPressable(
  props: ComponentProps<typeof Pressable> & {
    readonly index: number;
    readonly count: number;
    readonly vertical: number;
  },
) {
  const { index, count, vertical, onLayout, ...rest } = props;
  const [width, setWidth] = useState(44);
  return (
    <Pressable
      {...rest}
      hitSlop={teamBoardChipHitSlop(width, index, count, vertical)}
      onLayout={(event) => {
        setWidth(event.nativeEvent.layout.width);
        onLayout?.(event);
      }}
    />
  );
}

/** A sideways strip of chips with no scrollbar. */
function ChipStrip(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly contentContainerClassName: string;
  readonly accessibilityLabel?: string;
}) {
  return (
    <View className={cn("grow-0 bg-sheet", props.className)}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityLabel={props.accessibilityLabel}
        className="grow-0"
        contentContainerClassName={props.contentContainerClassName}
      >
        {props.children}
      </ScrollView>
    </View>
  );
}

/** Stays above the list while it scrolls. */
function FilterChips(props: {
  readonly filter: TeamBoardFilter;
  readonly onFilterChange: (filter: TeamBoardFilter) => void;
}) {
  return (
    // 32 pt chips touch at 44 pt inside the strip's own padding.
    <ChipStrip contentContainerClassName="gap-1.5 px-5 py-1.5">
      {TEAM_BOARD_FILTERS.map((entry, index) => {
        const selected = entry.id === props.filter;
        return (
          <ChipPressable
            key={entry.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`Show ${entry.label.toLowerCase()}`}
            onPress={() => props.onFilterChange(entry.id)}
            index={index}
            count={TEAM_BOARD_FILTERS.length}
            vertical={6}
            className={cn(
              "min-h-8 justify-center rounded-full px-3 active:opacity-70",
              selected ? "bg-subtle-strong" : "bg-subtle",
            )}
          >
            <Text
              className={cn(
                "text-xs font-t3-medium",
                selected ? "text-foreground" : "text-foreground-muted",
              )}
            >
              {entry.label}
            </Text>
          </ChipPressable>
        );
      })}
    </ChipStrip>
  );
}

function FilesList(props: {
  readonly files: ReadonlyArray<TeamBoardFile>;
  readonly agentName: string | null;
  readonly drivers: TeamBoardDrivers;
}) {
  if (props.files.length === 0) {
    return (
      <ScrollView className="flex-1" contentContainerClassName="pb-4">
        <Text className="px-5 py-6 text-center text-sm text-foreground-muted">
          {props.agentName === null
            ? "No file is being edited by two subagents."
            : `${props.agentName} shares no files yet.`}
        </Text>
      </ScrollView>
    );
  }
  return (
    <ScrollView className="flex-1" contentContainerClassName="pb-4">
      {props.files.map((file) => (
        <View key={file.path} className="gap-1.5 border-b border-border-subtle px-5 py-3">
          <View className="min-w-0 flex-row items-center gap-2">
            <Text
              numberOfLines={1}
              ellipsizeMode="middle"
              className="min-w-0 flex-1 font-mono text-sm text-foreground"
            >
              {file.path}
            </Text>
            {file.willConflict === true ? (
              <View className="rounded-md bg-adaptive-amber-500-a12-a16 px-1.5 py-px">
                <Text className="text-xs font-t3-medium text-adaptive-amber-700-300">
                  Will conflict
                </Text>
              </View>
            ) : file.willConflict === false ? (
              <Text className="text-xs text-foreground-muted">No conflict</Text>
            ) : null}
          </View>
          {file.agents.map((entry) => (
            <View
              key={teamBoardAuthorKey(entry.author)}
              className={cn("flex-row items-center gap-1.5", entry.stale && "opacity-60")}
            >
              <TeamBoardAuthorAvatar author={entry.author} drivers={props.drivers} small />
              <TeamBoardAuthorName author={entry.author} drivers={props.drivers} />
              <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted">
                {[
                  formatTeamBoardRanges(entry.ranges),
                  ...(entry.claims ?? []).map((claim) => {
                    const label = teamBoardFileLabel(claim);
                    return label.symbol ? `editing ${label.symbol}` : "editing the file";
                  }),
                  // No change in a while: the range may no longer be what it edits.
                  entry.stale ? "stale" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

function TeamComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** With two or more live repositories, the one this post goes to. */
  readonly repo: string | null;
  readonly canPost: boolean;
  readonly replyTo: TeamBoardPost | null;
  readonly onClearReply: () => void;
  readonly bottomInset: number;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const post = useAtomCommand(teamBoardEnvironment.post, {
    label: "message the team",
    reportFailure: false,
  });
  const parsed = parseTeamBoardDraft(draft);
  const lengthError = teamBoardDraftError(draft);
  const canSend = props.canPost && !pending && parsed.text.length > 0 && lengthError === null;
  const send = async () => {
    if (!canSend) return;
    setPending(true);
    setError(null);
    const result = await post({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        text: parsed.text,
        ...(props.repo === null ? {} : { repo: props.repo }),
        ...(props.replyTo ? { replyTo: props.replyTo.id } : {}),
        ...(parsed.decision ? { decision: true } : {}),
        clientRequestId: uuidv4(),
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      setDraft("");
      props.onClearReply();
    } else {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error && cause.message ? cause.message : "The post did not send.");
    }
  };
  const note =
    error ??
    lengthError ??
    (parsed.decision ? "Posts a pinned decision every subagent reads first." : null);
  return (
    <View
      className="gap-1.5 border-t border-border-subtle px-4 pt-2"
      style={{ paddingBottom: props.bottomInset }}
    >
      {props.replyTo ? (
        <View className="-mt-2 min-h-11 flex-row items-center gap-1.5">
          <SymbolView
            name="arrow.turn.left.up"
            size={11}
            tintColorClassName="accent-foreground-muted"
          />
          <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
            Replying to {props.replyTo.author.user ? "you" : props.replyTo.author.name}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
            onPress={props.onClearReply}
            className="-mr-2.5 h-11 w-11 items-center justify-center active:opacity-60"
          >
            <SymbolView name="xmark" size={10} tintColorClassName="accent-icon" type="monochrome" />
          </Pressable>
        </View>
      ) : null}
      <View className="flex-row items-end gap-2">
        <TextInput
          multiline
          value={draft}
          editable={props.canPost && !pending}
          onChangeText={(text) => {
            setDraft(text);
            setError(null);
          }}
          placeholder={
            props.canPost ? "Message the team" : "This connection can't post to the team"
          }
          accessibilityLabel="Message the team"
          className="max-h-32 min-h-11 flex-1 rounded-[22px] py-2.5"
        />
        <View className="pb-1">
          <ControlPill
            accessibilityLabel={parsed.decision ? "Post decision" : "Send to the team"}
            variant="primary"
            disabled={!canSend}
            onPress={() => void send()}
            {...(pending
              ? {
                  iconNode: (
                    <AppActivityIndicator size="small" colorClassName="accent-primary-foreground" />
                  ),
                }
              : { icon: "arrow.up" as const })}
          />
        </View>
      </View>
      {note ? (
        <Text
          className={cn(
            "px-1 text-xs",
            error || lengthError ? "text-danger-foreground" : "text-foreground-muted",
          )}
        >
          {note}
        </Text>
      ) : null}
    </View>
  );
}
