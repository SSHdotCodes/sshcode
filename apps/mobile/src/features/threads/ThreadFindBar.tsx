import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import type { ThreadFindAnchorReader } from "./thread-find";
import { useMobileThreadFind } from "./useMobileThreadFind";

export function ThreadFindBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly progressive: boolean;
  readonly contentRevision: object | null;
  readonly readAnchor: ThreadFindAnchorReader;
  readonly onReveal: (entryId: string) => void;
  readonly onClose: () => void;
}) {
  const find = useMobileThreadFind(props);
  const { query, result, canStep } = find;
  const label =
    query.length === 0
      ? ""
      : find.error
        ? "Search failed"
        : (!result && find.isPending) || result?.complete === false
          ? "Searching…"
          : result && result.totalMatches > 0
            ? `${result.activeIndex + 1} of ${result.totalMatches}`
            : "No matches";
  return (
    <View className="mx-2 mb-2 flex-row items-center rounded-xl border border-border bg-screen px-1">
      <TextInput
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Find in chat"
        className="min-w-0 flex-1 px-2 py-2 text-base text-foreground"
        maxLength={200}
        placeholder="Find in chat"
        returnKeyType="search"
        value={find.input}
        onChangeText={find.changeQuery}
      />
      <Text className="shrink-0 text-xs text-foreground-muted" accessibilityLiveRegion="polite">
        {label}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Previous match"
        accessibilityState={{ disabled: !canStep }}
        className="size-10 items-center justify-center"
        disabled={!canStep}
        onPress={() => find.step(-1)}
      >
        <SymbolView
          name="chevron.up"
          size={16}
          tintColorClassName={canStep ? "accent-foreground" : "accent-foreground-muted"}
        />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Next match"
        accessibilityState={{ disabled: !canStep }}
        className="size-10 items-center justify-center"
        disabled={!canStep}
        onPress={() => find.step(1)}
      >
        <SymbolView
          name="chevron.down"
          size={16}
          tintColorClassName={canStep ? "accent-foreground" : "accent-foreground-muted"}
        />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close Find in chat"
        className="size-10 items-center justify-center"
        onPress={props.onClose}
      >
        <SymbolView name="xmark" size={16} tintColorClassName="accent-foreground" />
      </Pressable>
    </View>
  );
}
