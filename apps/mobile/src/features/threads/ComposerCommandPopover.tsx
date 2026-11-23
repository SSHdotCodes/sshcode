import { ProviderIcon } from "../../components/ProviderIcon";
import type { ModelOption } from "../../lib/modelOptions";
import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import type {
  PullRequestContextMetadata,
  ScopedThreadRef,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  WorkflowDefinition,
} from "@t3tools/contracts";
import type { ComposerTriggerKind } from "@t3tools/shared/composerTrigger";
import { memo } from "react";
import { FlatList, Pressable, StyleSheet, View, type ViewStyle } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GlassSurface } from "../../components/GlassSurface";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
export type ComposerCommandItem =
  | {
      readonly id: string;
      readonly type: "model";
      readonly option: ModelOption;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "pull-request";
      readonly pullRequest: PullRequestContextMetadata;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "path";
      readonly path: string;
      readonly kind: "file" | "directory";
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "thread";
      readonly thread: ScopedThreadRef;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "workflow";
      readonly workflow: WorkflowDefinition;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "slash-command";
      readonly command: string;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "provider-slash-command";
      readonly command: ServerProviderSlashCommand;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly type: "skill";
      readonly skill: ServerProviderSkill;
      readonly label: string;
      readonly description: string;
    };

interface ComposerCommandPopoverProps {
  readonly items: ReadonlyArray<ComposerCommandItem>;
  readonly triggerKind: ComposerTriggerKind | null;
  readonly isLoading: boolean;
  readonly error?: string | null;
  readonly onSelect: (item: ComposerCommandItem) => void;
}

function PopoverSurface(props: { readonly children: React.ReactNode; readonly style?: ViewStyle }) {
  const baseStyle: ViewStyle = {
    borderRadius: 16,
    overflow: "hidden",
    ...props.style,
  };

  return (
    <GlassSurface
      glassEffectStyle="clear"
      tintColorClassName="accent-glass-surface"
      style={baseStyle}
    >
      {props.children}
    </GlassSurface>
  );
}

const SKILL_SOURCE_SYMBOL_BY_KIND: Record<ProviderSkillSourceKind, AppSymbolName> = {
  app: "square.grid.2x2",
  repo: "folder",
  project: "folder",
  personal: "person.crop.circle",
  system: "gearshape",
  other: "cube",
};

function itemIcon(item: ComposerCommandItem): AppSymbolName | null {
  switch (item.type) {
    case "pull-request":
      return { ios: "arrow.triangle.pull", android: "merge" };
    case "slash-command":
    case "provider-slash-command":
      return "terminal";
    case "skill":
      return SKILL_SOURCE_SYMBOL_BY_KIND[resolveProviderSkillSourceKind(item.skill)];
    case "path":
    case "model":
      return null;
    case "thread":
      return "text.bubble";
    case "workflow":
      return "arrow.triangle.branch";
  }
}

function mentionGroup(item: ComposerCommandItem | undefined) {
  return item?.type === "model" ? "Models" : item?.type === "path" ? "Files" : "Mentions";
}

function groupLabel(
  triggerKind: ComposerTriggerKind | null,
  items: ReadonlyArray<ComposerCommandItem>,
): string | null {
  switch (triggerKind) {
    case "pull-request":
      return "Pull requests";
    case "slash-command":
      return "Commands";
    case "skill":
      return "Skills";
    case "path":
      return items.every((item) => item.type === "path") ? "Files" : "Mentions";
    case "chat":
      return "Chats";
    default:
      return null;
  }
}

function emptyText(triggerKind: ComposerTriggerKind | null, isLoading: boolean): string {
  if (isLoading) {
    if (triggerKind === "chat") return "Finding the chat you mean…";
    return triggerKind === "path" ? "Searching files…" : "Loading…";
  }
  switch (triggerKind) {
    case "pull-request":
      return "No matching pull requests.";
    case "path":
      return "No matching files or folders.";
    case "chat":
      return "No chat matches that description.";
    case "skill":
      return "No skills found.";
    case "slash-command":
      return "No matching commands.";
    default:
      return "No results.";
  }
}

/**
 * Slash commands and skills read like the Claude Code and Codex menus: the
 * `/name` on top and what it does underneath, with no icons.
 */
const SlashCommandRow = memo(function SlashCommandRow(props: {
  readonly item: ComposerCommandItem;
  readonly onPress: () => void;
  readonly isLast: boolean;
}) {
  const hint =
    props.item.type === "provider-slash-command" ? props.item.command.input?.hint : undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.item.description ? `${props.item.label}, ${props.item.description}` : props.item.label
      }
      onPress={props.onPress}
      className="min-h-11 justify-center gap-0.5 border-border px-3.5 py-2 active:opacity-60"
      style={{ borderBottomWidth: props.isLast ? 0 : StyleSheet.hairlineWidth }}
    >
      <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
        {props.item.label}
        {hint ? <Text className="font-sans text-foreground-muted"> {hint}</Text> : null}
      </Text>
      {props.item.description ? (
        <Text className="text-xs leading-normal text-foreground-muted" numberOfLines={2}>
          {props.item.description}
        </Text>
      ) : null}
    </Pressable>
  );
});

const CommandRow = memo(function CommandRow(props: {
  readonly item: ComposerCommandItem;
  readonly onPress: () => void;
  readonly isLast: boolean;
}) {
  const iconName = itemIcon(props.item);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="min-h-11 flex-row items-center gap-2.5 border-border px-3.5 py-2.5 active:opacity-60"
      style={{ borderBottomWidth: props.isLast ? 0 : StyleSheet.hairlineWidth }}
    >
      {props.item.type === "path" ? (
        <PierreEntryIcon path={props.item.path} kind={props.item.kind} size={16} />
      ) : props.item.type === "model" ? (
        <ProviderIcon
          provider={props.item.option.providerDriver}
          iconUrl={props.item.option.providerIconUrl}
          size={16}
        />
      ) : iconName ? (
        <SymbolView
          name={iconName}
          size={14}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
        />
      ) : null}
      <Text className="shrink-0 text-base font-t3-medium text-foreground" numberOfLines={1}>
        {props.item.label}
      </Text>
      {props.item.description ? (
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {props.item.description}
        </Text>
      ) : null}
    </Pressable>
  );
});

export const ComposerCommandPopover = memo(function ComposerCommandPopover(
  props: ComposerCommandPopoverProps,
) {
  const isSlashMenu = props.triggerKind === "slash-command";
  const hasModels =
    props.triggerKind === "path" && props.items.some((item) => item.type === "model");
  const label = isSlashMenu || hasModels ? null : groupLabel(props.triggerKind, props.items);
  const Row = isSlashMenu ? SlashCommandRow : CommandRow;

  return (
    <PopoverSurface>
      {label ? (
        <View className="px-3.5 pt-2.5 pb-1">
          <Text className="text-3xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
            {label}
          </Text>
        </View>
      ) : null}
      {props.items.length > 0 ? (
        <FlatList
          style={{ maxHeight: isSlashMenu ? 232 : 180 }}
          data={props.items}
          keyExtractor={(item) => item.id}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={3}
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
          renderItem={({ item, index }) => (
            <>
              {hasModels &&
              (index === 0 || mentionGroup(item) !== mentionGroup(props.items[index - 1])) ? (
                <View className="px-3.5 pt-2.5 pb-1">
                  <Text className="text-3xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
                    {mentionGroup(item)}
                  </Text>
                </View>
              ) : null}
              <Row
                item={item}
                onPress={() => props.onSelect(item)}
                isLast={index === props.items.length - 1}
              />
            </>
          )}
        />
      ) : (
        <View className="px-3.5 py-2.5">
          <Text className="text-xs text-foreground-tertiary">
            {props.error ?? emptyText(props.triggerKind, props.isLoading)}
          </Text>
        </View>
      )}
    </PopoverSurface>
  );
});
