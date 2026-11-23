import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  MessageId,
  type EnvironmentId,
  type OrchestrationV2Run,
  type OrchestrationV2AppThread,
  type ProviderCredentialRecovery,
  type RunId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useContext, useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView } from "react-native";

import { AppSheet } from "../../components/AppSheet";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { uuidv4 } from "../../lib/uuid";
import { serverEnvironment } from "../../state/server";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** Credential entry stays in this sheet and never becomes a composer draft. */
export function ReplaceProviderCredentialButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const run = useAtomValue(environmentThreadDetails.threadAtom(threadRef), (detail) => {
    const latest = detail?.projection.runs.at(-1);
    return latest?.id === props.runId && latest.status === "failed" ? latest : null;
  });
  const thread = useAtomValue(
    environmentThreadDetails.threadAtom(threadRef),
    (detail) => detail?.projection.thread ?? null,
  );
  const latestFailed = useAtomValue(
    environmentThreadShells.threadShellAtom(threadRef),
    (shell) => shell?.latestRun?.runId === props.runId && shell.latestRun.status === "failed",
  );
  const allowed = useAtomValue(
    serverEnvironment.replaceProviderCredential.permissionAtom(props.environmentId),
  );
  const [open, setOpen] = useState(false);
  if (
    !allowed ||
    !latestFailed ||
    thread === null ||
    run?.id !== props.runId ||
    run.status !== "failed" ||
    run.credentialRecovery === undefined
  )
    return null;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        className="mt-2 min-h-11 items-center justify-center rounded-full bg-primary px-4 active:opacity-70"
      >
        <Text className="font-t3-medium text-sm text-primary-foreground">Replace API key</Text>
      </Pressable>
      {open ? (
        <ReplaceCredentialSheet
          key={run.credentialRecovery.credentialRef}
          threadRef={threadRef}
          run={run}
          thread={thread}
          recovery={run.credentialRecovery}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ReplaceCredentialSheet(props: {
  readonly threadRef: ScopedThreadRef;
  readonly run: OrchestrationV2Run;
  readonly thread: Pick<OrchestrationV2AppThread, "runtimeMode" | "interactionMode">;
  readonly recovery: ProviderCredentialRecovery;
  readonly onClose: () => void;
}) {
  // Credential-bearing failures stay out of the command reporter.
  const registry = useContext(RegistryContext);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, {
    reportFailure: false,
    reportDefect: false,
  });
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const active = useRef(true);
  const pasteRequest = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const close = () => {
    active.current = false;
    pasteRequest.current++;
    setValue("");
    props.onClose();
  };
  const submit = async () => {
    if (inFlight.current || (!saved && !value.trim())) return;
    inFlight.current = true;
    pasteRequest.current++;
    setBusy(true);
    setError(null);
    let keySaved = saved;
    try {
      if (!keySaved) {
        const result = await serverEnvironment.replaceProviderCredential.run(registry, {
          environmentId: props.threadRef.environmentId,
          input: { credentialRef: props.recovery.credentialRef, value: value.trim() },
        });
        if (result._tag !== "Success") {
          if (active.current) setError("Could not save the API key. Try again.");
          return;
        }
        keySaved = true;
        setValue("");
        setSaved(true);
      }
      if (!active.current) return;
      const result = await startTurn({
        environmentId: props.threadRef.environmentId,
        input: {
          threadId: props.threadRef.threadId,
          message: {
            messageId: MessageId.make(uuidv4()),
            role: "user",
            text: "Continue.",
            attachments: [],
          },
          modelSelection: props.run.modelSelection,
          runtimeMode: props.thread.runtimeMode,
          interactionMode: props.thread.interactionMode,
          dispatchMode: "auto",
        },
      });
      if (!active.current) return;
      if (result._tag === "Success") close();
      else setError("Key saved. Could not retry. Try again.");
    } catch {
      if (active.current)
        setError(
          keySaved
            ? "Key saved. Could not retry. Try again."
            : "Could not save the API key. Try again.",
        );
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };

  const paste = async () => {
    const request = ++pasteRequest.current;
    try {
      const text = await Clipboard.getStringAsync();
      if (active.current && request === pasteRequest.current && !inFlight.current) setValue(text);
    } catch {
      if (active.current) setError("Could not paste. Enter the key instead.");
    }
  };

  return (
    <AppSheet title="Replace API key" onClose={close}>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerClassName="gap-4 p-5 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Text className="font-t3-bold text-base text-foreground">{props.recovery.label}</Text>
        {props.recovery.consoleUrl ? (
          <MaterialButton
            label="Get API key"
            tone="text"
            onPress={() => void tryOpenExternalUrl(props.recovery.consoleUrl!, "provider-auth")}
          />
        ) : null}
        {props.recovery.alsoUsedBy.length > 0 ? (
          <Text className="text-sm text-foreground-muted">
            Also used by: {props.recovery.alsoUsedBy.join(", ")}
          </Text>
        ) : null}
        {!saved ? (
          <>
            <Text className="text-sm text-foreground">New API key</Text>
            <TextInput
              accessibilityLabel="New API key"
              className="rounded-xl border border-border px-3 py-3 text-base text-foreground"
              value={value}
              onChangeText={setValue}
              editable={!busy}
              secureTextEntry
              autoCorrect={false}
              autoCapitalize="none"
              autoComplete="off"
              textContentType="none"
              importantForAutofill="no"
              spellCheck={false}
              returnKeyType="done"
              onSubmitEditing={() => void submit()}
            />
            <MaterialButton
              label="Paste"
              tone="secondary"
              disabled={busy}
              onPress={() => void paste()}
            />
          </>
        ) : (
          <Text className="text-sm text-foreground-muted">API key saved.</Text>
        )}
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
        <MaterialButton
          label={busy ? (saved ? "Retrying…" : "Saving…") : saved ? "Retry" : "Save and retry"}
          tone="primary"
          fullWidth
          disabled={busy || (!saved && !value.trim())}
          onPress={() => void submit()}
        />
        <MaterialButton label="Cancel" tone="text" fullWidth onPress={close} />
      </ScrollView>
    </AppSheet>
  );
}
