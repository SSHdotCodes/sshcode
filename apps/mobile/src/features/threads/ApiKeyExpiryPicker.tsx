import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  API_KEY_EXPIRY_PRESETS,
  apiKeyExpiryFromDays,
  apiKeyExpiryLabel,
} from "@t3tools/client-runtime/secret-request";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";

export function ApiKeyExpiryPicker(props: {
  readonly value: number | null;
  readonly onChange: (value: number | null) => void;
  readonly disabled?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const [openedAt] = useState(Date.now);
  const [preset, setPreset] = useState<string | null>(
    () =>
      API_KEY_EXPIRY_PRESETS.find(({ days }) =>
        props.value === null
          ? days === null
          : days !== null && Math.abs(props.value - openedAt - days * 86_400_000) < 60_000,
      )?.label ?? null,
  );
  return (
    <View className="gap-2">
      <Text className="text-xs text-foreground-muted">
        Delete after · {apiKeyExpiryLabel(props.value)}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {API_KEY_EXPIRY_PRESETS.map(({ label, days }) => (
          <Pressable
            key={label}
            accessibilityRole="button"
            accessibilityState={{ selected: preset === label, disabled: props.disabled ?? false }}
            disabled={props.disabled}
            className="min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-border px-3 active:opacity-60 disabled:opacity-50"
            onPress={() => {
              setPreset(label);
              setCustom(false);
              props.onChange(apiKeyExpiryFromDays(days, Date.now()));
            }}
          >
            <Text
              className={
                preset === label ? "font-t3-bold text-foreground" : "text-foreground-muted"
              }
            >
              {label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          disabled={props.disabled}
          className="min-h-[44px] items-center justify-center rounded-xl border border-border px-3 active:opacity-60 disabled:opacity-50"
          onPress={() => setCustom(!custom)}
        >
          <Text>Custom date</Text>
        </Pressable>
      </View>
      {custom ? (
        <DateTimePicker
          value={new Date(props.value ?? openedAt + 86_400_000)}
          disabled={props.disabled}
          mode="date"
          display={Platform.OS === "ios" ? "spinner" : "default"}
          minimumDate={new Date(openedAt)}
          onDismiss={() => setCustom(false)}
          onValueChange={(_, selected) => {
            if (props.disabled) return;
            const date = new Date(selected);
            date.setHours(23, 59, 59, 0);
            setPreset(null);
            props.onChange(date.getTime());
          }}
        />
      ) : null}
    </View>
  );
}
