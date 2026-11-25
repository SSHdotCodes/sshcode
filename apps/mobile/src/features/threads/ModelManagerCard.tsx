import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ModelManagerReply, ProviderInstanceId } from "@t3tools/contracts";
import {
  defaultModelManagerHarness,
  modelManagerRequestText,
  type ModelManagerHarness,
  type ModelRef,
} from "@t3tools/shared/modelRefs";
import { type ReactNode, useState, useRef } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { cn } from "../../lib/cn";
import { environmentThreadShells } from "../../state/threads";
import { ModelManagerBox } from "./ModelManagerBox";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export interface ModelManagerCardHarness extends ModelManagerHarness {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "sent" }
  | { readonly kind: "error"; readonly message: string };

function CardRow(props: { readonly children: ReactNode; readonly isLast?: boolean }) {
  return (
    <View
      className={cn(
        "min-h-11 flex-row items-center gap-2 bg-grouped-card px-4 py-2 android:min-h-14",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      {props.children}
    </View>
  );
}

function RowButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly muted?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      hitSlop={8}
      onPress={props.onPress}
      className="min-h-[44px] justify-center px-1 active:opacity-60"
    >
      <Text
        className={cn(
          "text-sm font-t3-medium",
          props.muted ? "text-foreground-muted" : "text-primary-text",
          props.disabled && "opacity-40",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function HarnessRow(props: {
  readonly harnesses: ReadonlyArray<ModelManagerCardHarness>;
  readonly selected: ModelManagerCardHarness;
  readonly onSelect: (instanceId: ProviderInstanceId) => void;
  readonly label: string;
}) {
  return (
    <ControlPillMenu
      accessibilityLabel={`${props.label}, ${props.selected.label}`}
      actions={props.harnesses.map((harness) => ({
        id: harness.instanceId,
        title: harness.enabled ? harness.label : `${harness.label} (off)`,
        state: harness.instanceId === props.selected.instanceId ? "on" : "off",
      }))}
      onPressAction={({ nativeEvent }) => {
        const picked = props.harnesses.find((harness) => harness.instanceId === nativeEvent.event);
        if (picked) props.onSelect(picked.instanceId);
      }}
    >
      <Pressable
        accessibilityRole="button"
        className="min-h-[44px] flex-row items-center gap-2 border-b border-border-subtle bg-grouped-card px-4 py-2 active:bg-subtle android:min-h-14"
      >
        <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
        <View className="flex-1" />
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.selected.label}
        </Text>
        <SymbolView
          name="chevron.down"
          size={12}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </Pressable>
    </ControlPillMenu>
  );
}

/**
 * Below the phone's model list: paste a model id or URL (or "remove …"), pick a harness,
 * and the Models chat edits that harness's config. Searching for a model no harness lists
 * offers the same in one tap.
 */
export function ModelManagerCard(props: {
  readonly environmentId: EnvironmentId;
  readonly harnesses: ReadonlyArray<ModelManagerCardHarness>;
  /** The harness the list is filtered to, if any. */
  readonly browsingInstanceId: string | null;
  /** A model the search names that no harness lists yet. */
  readonly searchedModel: { readonly ref: ModelRef; readonly query: string } | null;
}) {
  const helperRef = useAtomValue(
    environmentThreadShells.modelManagerThreadRefAtom(props.environmentId),
  );
  const inFlight = useRef(false);
  const [reply, setReply] = useState<ModelManagerReply | null>(null);
  const requestModelChange = useAtomCommand(serverEnvironment.requestModelChange, {
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const harnessId =
    instanceId !== null && props.harnesses.some((harness) => harness.instanceId === instanceId)
      ? instanceId
      : defaultModelManagerHarness(props.harnesses, props.browsingInstanceId);
  const harness = props.harnesses.find((entry) => entry.instanceId === harnessId) ?? null;

  if (harness === null) return null;

  const submit = async (requestText: string): Promise<boolean> => {
    if (requestText.trim().length === 0 || inFlight.current) return false;
    inFlight.current = true;
    setPhase({ kind: "sending" });
    const result = await requestModelChange({
      environmentId: props.environmentId,
      input: { text: modelManagerRequestText(requestText), instanceId: harness.instanceId },
    });
    inFlight.current = false;
    if (result._tag === "Success") {
      setPhase({ kind: "sent" });
      setReply(result.value);
      setText("");
      setOpen(false);
      return true;
    }
    if (isAtomCommandInterrupted(result)) {
      setPhase({ kind: "idle" });
      return false;
    }
    const error = squashAtomCommandFailure(result);
    setPhase({
      kind: "error",
      message: error instanceof Error ? error.message : "The request didn't reach the server.",
    });
    return false;
  };

  const sending = phase.kind === "sending";
  const harnessRow = (
    <HarnessRow
      harnesses={props.harnesses}
      selected={harness}
      onSelect={setInstanceId}
      label={props.searchedModel !== null && !open ? "Add to" : "Harness"}
    />
  );

  let rows: ReactNode;
  const activeReply =
    reply ??
    (helperRef
      ? { threadId: helperRef.threadId, delivery: "started" as const, runId: null }
      : null);
  if (activeReply !== null && !open && (phase.kind !== "idle" || props.searchedModel === null)) {
    rows = (
      <>
        {harnessRow}
        <ModelManagerBox
          key={activeReply.threadId}
          environmentId={props.environmentId}
          reply={activeReply}
          sending={sending}
          onSend={submit}
        />
      </>
    );
  } else if (props.searchedModel !== null && !open) {
    const { ref, query } = props.searchedModel;
    rows = (
      <>
        <CardRow>
          <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={2}>
            No harness lists <Text className="font-t3-medium">{ref.id}</Text> yet.
          </Text>
        </CardRow>
        {harnessRow}
        <CardRow isLast>
          {sending ? <AppActivityIndicator size="small" colorClassName="accent-icon" /> : null}
          <RowButton
            label={sending ? "Adding…" : `Add ${ref.id}`}
            disabled={sending}
            onPress={() => submit(query)}
          />
        </CardRow>
      </>
    );
  } else if (open) {
    rows = (
      <>
        <CardRow>
          <TextInput
            accessibilityLabel="Model to add or remove"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            className="min-h-[44px] min-w-0 flex-1 py-2 text-sm text-foreground"
            onChangeText={setText}
            onSubmitEditing={() => submit(text)}
            placeholder="Model id or URL to add, or “remove …”"
            placeholderTextColorClassName="accent-placeholder"
            returnKeyType="go"
            selectionColorClassName="accent-focus/32"
            cursorColorClassName="accent-focus"
            selectionHandleColorClassName="accent-focus"
            spellCheck={false}
            value={text}
          />
        </CardRow>
        {harnessRow}
        <CardRow isLast>
          <RowButton label="Cancel" muted onPress={() => setOpen(false)} />
          <View className="flex-1" />
          {sending ? <AppActivityIndicator size="small" colorClassName="accent-icon" /> : null}
          <RowButton
            label={sending ? "Sending…" : "Go"}
            disabled={sending || text.trim().length === 0}
            onPress={() => submit(text)}
          />
        </CardRow>
      </>
    );
  } else {
    rows = (
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        className="min-h-[44px] flex-row items-center gap-2 bg-grouped-card px-4 py-2 active:bg-subtle android:min-h-14"
      >
        <SymbolView
          name="plus"
          size={14}
          tintColorClassName="accent-primary-text"
          type="monochrome"
        />
        <Text className="text-sm font-t3-medium text-primary-text">Add or remove models</Text>
      </Pressable>
    );
  }

  return (
    <View className="pt-3" testID="model-manager-card">
      <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">{rows}</View>
      {phase.kind === "error" ? (
        <Text accessibilityRole="alert" className="mx-5 mt-2 text-xs text-danger-foreground">
          {phase.message}
        </Text>
      ) : null}
    </View>
  );
}
