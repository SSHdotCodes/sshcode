import { ApiKeyExpiryPicker } from "./ApiKeyExpiryPicker";
import { useAtomValue } from "@effect/atom-react";
import type { ApiKeyScope } from "@t3tools/contracts";
import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  secretRequestPrivacyNote,
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "./RequestActionButton";

/**
 * Feed card for a secret an agent asked the user for. The typed value lives
 * only in this component's state and the RPC payload: it is never logged,
 * alerted, or persisted, and the field clears once the answer is sent.
 */
const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };
const PRIVATE_SYMBOL: AppSymbolName = { ios: "checkmark.shield", android: "lock" };

export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item, visibility } = props.projectedItem;
  if (item.type !== "secret_request") return null;
  const display = secretRequestDisplay(item, visibility);
  if (display.kind === "pending") {
    return (
      <PendingSecretRequestForm
        environmentId={props.environmentId}
        item={item}
        iconColor={props.iconColor}
      />
    );
  }
  const icon: AppSymbolName =
    display.kind === "pending-elsewhere"
      ? LOCK_SYMBOL
      : display.outcome === "saved"
        ? "checkmark"
        : "minus";
  return (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView name={icon} size={13} tintColor={props.iconColor} type="monochrome" />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        {item.label} · {display.label}
      </Text>
    </View>
  );
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly iconColor: ColorValue;
}) {
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const allowed = useAtomValue(
    serverEnvironment.answerSecretRequest.permissionAtom(props.environmentId),
  );
  const [openedAt] = useState(Date.now);
  const [revealed, setRevealed] = useState(false);
  const [scope, setScope] = useState<ApiKeyScope>(item.apiKey?.suggestedScope ?? "chat");
  const [expiresAt, setExpiresAt] = useState<number | null>(() =>
    item.apiKey?.suggestedExpiresAt === undefined
      ? openedAt + 30 * 86_400_000
      : item.apiKey.suggestedExpiresAt,
  );
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Submit then a tap can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (
    reply: { readonly type: "save"; readonly secret: string } | { readonly type: "decline" },
  ) => {
    const input = secretRequestAnswerInput(
      item,
      reply.type === "save" && item.apiKey !== undefined ? { ...reply, scope, expiresAt } : reply,
    );
    if (input === null || inFlight.current || !allowed) return;
    if (
      reply.type === "save" &&
      item.apiKey !== undefined &&
      expiresAt !== null &&
      expiresAt <= Date.now()
    ) {
      setError("Choose an expiry in the future, or Never.");
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      // The card switches to its answered row once the item updates.
      setSecret("");
      setRevealed(false);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  // Same hierarchy as web: what is asked, why, the field, then the promise
  // about where the value goes.
  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">{item.label}</Text>
        {item.apiKey ? (
          <Text className="font-mono text-xs text-foreground-muted">{item.apiKey.name}</Text>
        ) : null}
        {item.reason.trim() ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">{item.reason}</Text>
        ) : null}
      </View>
      <TextInput
        accessibilityLabel={item.label}
        placeholder={item.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER}
        value={secret}
        onChangeText={setSecret}
        editable={!submitting && allowed}
        secureTextEntry={!revealed}
        autoCorrect={false}
        autoCapitalize="none"
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        spellCheck={false}
        returnKeyType="done"
        onSubmitEditing={() => void send({ type: "save", secret })}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={revealed ? "Hide key" : "Reveal key"}
        disabled={submitting || !allowed}
        className="min-h-[44px] items-center justify-center active:opacity-60"
        onPress={() => setRevealed(!revealed)}
      >
        <Text className="text-sm text-foreground-muted">{revealed ? "Hide key" : "Show key"}</Text>
      </Pressable>
      {item.apiKey ? (
        <View className="gap-3">
          <View className="flex-row gap-2">
            {(["chat", "all"] as const).map((choice) => (
              <Pressable
                key={choice}
                accessibilityRole="button"
                accessibilityState={{ selected: scope === choice }}
                disabled={submitting || !allowed}
                className="min-h-[44px] flex-1 items-center justify-center rounded-xl border border-border px-3 active:opacity-60 disabled:opacity-50"
                onPress={() => setScope(choice)}
              >
                <Text
                  className={
                    scope === choice ? "font-t3-bold text-foreground" : "text-foreground-muted"
                  }
                >
                  {choice === "chat" ? "This chat only" : "All sessions"}
                </Text>
              </Pressable>
            ))}
          </View>
          <ApiKeyExpiryPicker
            value={expiresAt}
            onChange={setExpiresAt}
            disabled={submitting || !allowed}
          />
        </View>
      ) : null}
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      <RequestActionButton
        label={submitting ? "Sending…" : "Save"}
        accessibilityState={{ busy: submitting }}
        disabled={
          submitting ||
          !allowed ||
          secret.trim().length === 0 ||
          (item.apiKey !== undefined && expiresAt !== null && expiresAt <= openedAt)
        }
        onPress={() => void send({ type: "save", secret })}
      />
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-1 flex-row items-center gap-1.5">
          <SymbolView
            name={PRIVATE_SYMBOL}
            size={13}
            tintColor={props.iconColor}
            type="monochrome"
          />
          <Text className="flex-1 font-sans text-xs text-foreground-muted">
            {secretRequestPrivacyNote(item)}
          </Text>
        </View>
        {/* Quiet like the web card's: the field and Save are the action. */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: submitting }}
          disabled={submitting || !allowed}
          hitSlop={8}
          className="min-h-[44px] min-w-[44px] items-center justify-center px-2 active:opacity-60 disabled:opacity-50"
          onPress={() => void send({ type: "decline" })}
        >
          <Text className="font-sans text-xs text-foreground-muted">Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}
