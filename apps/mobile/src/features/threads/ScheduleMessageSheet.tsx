import {
  mergeScheduledMessagePickerValue,
  scheduledMessagePickerValue,
} from "../../lib/scheduledMessagePicker";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { CommandId } from "@t3tools/contracts";
import {
  scheduledMessageInstant,
  scheduledMessageLocalDateTime,
} from "@t3tools/client-runtime/scheduled-message";
import { useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { uuidv4 } from "../../lib/uuid";

export function ScheduleMessageSheet(props: {
  readonly prompt: string;
  readonly disabledReason: string | null;
  readonly onClose: () => void;
  readonly onSchedule: (runAt: string, commandId: CommandId) => Promise<void>;
}) {
  const [when, setWhen] = useState(() => new Date(Date.now() + 3_600_000));
  const [picker, setPicker] = useState<"date" | "time" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const pending = useRef(false);
  const [commandId] = useState(() => CommandId.make(uuidv4()));
  const submit = async () => {
    if (pending.current || props.disabledReason) return;
    const runAt = scheduledMessageInstant(scheduledMessageLocalDateTime(when.getTime()));
    if (runAt === null) {
      setError("Choose a date and time in the future.");
      return;
    }
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      await props.onSchedule(runAt, commandId);
      props.onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not schedule the message. Your draft is saved.",
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal={!saving}
      onRequestClose={() => {
        if (!pending.current) props.onClose();
      }}
    >
      <View className="flex-1 bg-sheet">
        <View className="flex-row items-center justify-between gap-3 px-5 pt-3 pb-2">
          <Text
            accessibilityRole="header"
            className="min-w-0 flex-1 text-xl font-t3-semibold text-foreground"
          >
            Schedule message
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={props.onClose}
            className="justify-center active:opacity-60"
            style={{ minHeight: 44, minWidth: 44 }}
          >
            <Text className="text-base text-foreground">Cancel</Text>
          </Pressable>
        </View>
        <ScrollView className="flex-1" contentContainerClassName="gap-5 px-5 pb-12 pt-3">
          <Text className="text-base text-foreground-muted">
            Steer the agent if it is working, or start a turn if it is idle.
          </Text>
          <View className="rounded-2xl bg-card px-4">
            <Pressable
              accessibilityRole="button"
              onPress={() => setPicker("date")}
              disabled={saving}
              className="min-h-14 flex-row items-center justify-between"
            >
              <Text className="text-base text-foreground">Date</Text>
              <Text className="text-base text-foreground-muted">{when.toLocaleDateString()}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPicker("time")}
              disabled={saving}
              className="min-h-14 flex-row items-center justify-between border-t border-border-subtle"
            >
              <Text className="text-base text-foreground">Time</Text>
              <Text className="text-base text-foreground-muted">
                {when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </Text>
            </Pressable>
          </View>
          {picker ? (
            <DateTimePicker
              value={scheduledMessagePickerValue(when, picker, Platform.OS)}
              mode={picker}
              display={Platform.OS === "ios" ? "spinner" : "default"}
              onDismiss={() => setPicker(null)}
              onValueChange={(_, selected) => {
                const next = mergeScheduledMessagePickerValue(when, selected, picker, Platform.OS);
                if (next === null) {
                  setError(
                    "Choose a valid local date and time. This time may be skipped by daylight saving.",
                  );
                  return;
                }
                setWhen(next);
                setError(null);
              }}
            />
          ) : null}
          <Text className="text-sm text-foreground-muted">
            {Intl.DateTimeFormat().resolvedOptions().timeZone}. You can close the app. If the
            environment is offline, delivery waits until it returns.
          </Text>
          <View className="rounded-2xl bg-card p-4">
            <Text numberOfLines={expanded ? undefined : 3} className="text-base text-foreground">
              {props.prompt || "Write a message first."}
            </Text>
            {props.prompt ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => setExpanded((value) => !value)}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text className="text-sm text-foreground-muted">
                  {expanded ? "Show less" : "Show full message"}
                </Text>
              </Pressable>
            ) : null}
          </View>
          {props.disabledReason || error ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {props.disabledReason ?? error}
            </Text>
          ) : null}
          <MaterialButton
            label={saving ? "Scheduling…" : "Schedule message"}
            tone="primary"
            fullWidth
            disabled={saving || props.disabledReason !== null}
            onPress={() => void submit()}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}
