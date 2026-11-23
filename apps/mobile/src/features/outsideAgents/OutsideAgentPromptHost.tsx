import { useAtomValue } from "@effect/atom-react";
import type {
  AuthMcpClientAccess,
  EnvironmentId,
  OutsideAgentSignIn,
  OutsideAgentsCommand,
} from "@t3tools/contracts";
import { useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RUNTIME_MODE_CHOICES } from "../threads/thread-settings-options";

const ACCESS_CHOICES: ReadonlyArray<{
  readonly access: AuthMcpClientAccess;
  readonly label: string;
  readonly description: string;
}> = [
  {
    access: "read-only",
    label: "Read only",
    description: "Read projects and chats. Cannot start, message or change anything.",
  },
  ...RUNTIME_MODE_CHOICES.map((choice) => ({
    access: choice.mode,
    label: choice.label,
    description: choice.description,
  })),
];

/** Agents can start and message chats, which ask before commands and edits. */
const DEFAULT_ACCESS: AuthMcpClientAccess = "approval-required";

/**
 * Asks, on the phone, whether an outside agent waiting at its sign-in page
 * (Grok Bot, Claude Code elsewhere) may use an environment that has outside
 * agents turned on.
 */
export function OutsideAgentPromptHost() {
  const configs = useServerConfigs();
  return Array.from(configs)
    .filter(([, config]) => config.settings.outsideAgents === true)
    .map(([environmentId]) => (
      <EnvironmentOutsideAgentPrompt key={environmentId} environmentId={environmentId} />
    ));
}

function EnvironmentOutsideAgentPrompt({ environmentId }: { environmentId: EnvironmentId }) {
  const allowed = useAtomValue(
    serverEnvironment.outsideAgentsCommand.permissionAtom(environmentId),
  );
  const query = useEnvironmentQuery(
    allowed ? serverEnvironment.outsideAgentsState({ environmentId, input: {} }) : null,
  );
  const run = useAtomCommand(serverEnvironment.outsideAgentsCommand, "answer the sign-in");
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const pending = query.data?.enabled ? query.data.pending : [];
  if (!pending.some((signIn) => !dismissed.has(signIn.id))) return null;
  const later = () => setDismissed(new Set(pending.map((signIn) => signIn.id)));
  return (
    <OutsideAgentSheet
      pending={pending}
      onLater={later}
      onAnswer={async (input) => {
        const result = await run({ environmentId, input });
        return result._tag === "Success";
      }}
    />
  );
}

export function OutsideAgentSheet(props: {
  readonly pending: readonly OutsideAgentSignIn[];
  readonly onAnswer: (input: OutsideAgentsCommand) => Promise<boolean>;
  readonly onLater: () => void;
}) {
  const [code, setCode] = useState("");
  const signIn = code.length === 4 ? props.pending.find((item) => item.code === code) : undefined;
  const [access, setAccess] = useState<AuthMcpClientAccess>(DEFAULT_ACCESS);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const decide = async (choice: "approve" | "deny") => {
    if (signIn === undefined) return;
    setBusy(choice);
    try {
      const ok = await props.onAnswer(
        choice === "approve"
          ? { _tag: "approve", id: signIn.id, access, code }
          : { _tag: "deny", id: signIn.id },
      );
      if (ok) setCode("");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onLater}
    >
      <View className="flex-1 bg-background">
        <View className="flex-row items-center justify-between border-b border-border p-4">
          <Text className="text-lg font-semibold">Sign-in request</Text>
          <Pressable accessibilityRole="button" onPress={props.onLater} disabled={busy !== null}>
            <Text className="text-foreground-muted">Not now</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }}>
          <View className="gap-2">
            <Text className="text-sm font-semibold">Type the 4-digit code your browser shows.</Text>
            <TextInput
              accessibilityLabel="Type the 4-digit code your browser shows."
              autoFocus
              keyboardType="number-pad"
              autoComplete="off"
              value={code}
              editable={busy === null}
              onChangeText={(value) => setCode(value.replace(/[^0-9]/g, "").slice(0, 4))}
              className="rounded-[14px] border border-border p-3 text-xl text-foreground"
            />
          </View>
          {signIn === undefined ? (
            <Text className="text-sm text-foreground-muted">
              {code.length === 4
                ? "No sign-in has that code. Check the page in your browser."
                : `${props.pending.length} ${props.pending.length === 1 ? "sign-in" : "sign-ins"} waiting`}
            </Text>
          ) : (
            <>
              <View className="gap-2">
                <Text className="text-xl font-semibold text-foreground">
                  {signIn.clientName} wants to use SSHCode
                </Text>
                <Text className="text-sm text-foreground-muted">
                  Approving gives access to whoever runs {signIn.redirectHost}. The name is chosen
                  by the agent, so only approve a sign-in you just started.
                </Text>
              </View>
              <View className="gap-2">
                <Text className="text-xs font-semibold text-foreground-muted">WHAT IT MAY DO</Text>
                <Text className="text-sm text-foreground">
                  Access: {ACCESS_CHOICES.find((choice) => choice.access === access)?.label}
                </Text>
                {ACCESS_CHOICES.map((choice) => {
                  const selected = choice.access === access;
                  return (
                    <Pressable
                      key={choice.access}
                      accessibilityRole="radio"
                      accessibilityState={{ selected, disabled: busy !== null }}
                      disabled={busy !== null}
                      onPress={() => setAccess(choice.access)}
                      className={
                        selected
                          ? "rounded-[14px] border-2 border-primary px-3 py-2.5"
                          : "rounded-[14px] border border-border px-3 py-2.5"
                      }
                    >
                      <Text className="font-semibold text-foreground">{choice.label}</Text>
                      <Text className="text-xs text-foreground-muted">{choice.description}</Text>
                    </Pressable>
                  );
                })}
                <Text className="text-xs text-foreground-muted">
                  You can disconnect it any time in SSHCode on your Mac, under Settings →
                  Connections → Outside agents.
                </Text>
              </View>
              <View className="flex-row gap-3">
                <Pressable
                  accessibilityRole="button"
                  disabled={busy !== null}
                  onPress={() => void decide("deny")}
                  className="min-h-12 flex-1 items-center justify-center rounded-[14px] border border-border px-4 disabled:opacity-50"
                >
                  <Text className="font-semibold text-foreground">
                    {busy === "deny" ? "Denying…" : "Deny"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy !== null}
                  onPress={() => void decide("approve")}
                  className="min-h-12 flex-1 items-center justify-center rounded-[14px] bg-primary px-4 disabled:opacity-50"
                >
                  <Text className="font-semibold text-primary-foreground">
                    {busy === "approve" ? "Allowing…" : "Allow"}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
