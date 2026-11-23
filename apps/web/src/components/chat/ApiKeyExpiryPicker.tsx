import { useNowMinuteMs } from "../../hooks/useNowMinute";
import {
  API_KEY_EXPIRY_PRESETS,
  apiKeyExpiryFromDays,
  apiKeyCustomExpiry,
  apiKeyExpiryLabel,
} from "@t3tools/client-runtime/secret-request";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function ApiKeyExpiryPicker(props: {
  readonly value: number | null;
  readonly onChange: (value: number | null) => void;
  readonly disabled?: boolean;
}) {
  const nowMs = useNowMinuteMs();
  const [openedAt] = useState(Date.now);
  const [preset, setPreset] = useState(() => {
    const match = API_KEY_EXPIRY_PRESETS.find(({ days }) =>
      props.value === null
        ? days === null
        : days !== null && Math.abs(props.value - openedAt - days * 86_400_000) < 60_000,
    );
    return match ? { label: match.label, value: props.value } : null;
  });
  const [custom, setCustom] = useState(false);
  const selectedPreset = preset?.value === props.value ? preset.label : null;
  const showCustom = custom || selectedPreset === null;
  const date = props.value === null ? null : new Date(props.value);
  const dateValue = date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
    : "";
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-muted-foreground">{apiKeyExpiryLabel(props.value)}</span>
      <div className="flex flex-wrap gap-1.5">
        {API_KEY_EXPIRY_PRESETS.map(({ label, days }) => (
          <Button
            key={label}
            type="button"
            size="sm"
            variant={!showCustom && selectedPreset === label ? "secondary" : "outline"}
            aria-pressed={!showCustom && selectedPreset === label}
            disabled={props.disabled}
            onClick={() => {
              const value = apiKeyExpiryFromDays(days, Date.now());
              setPreset({ label, value });
              setCustom(false);
              props.onChange(value);
            }}
          >
            {label}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant={showCustom ? "secondary" : "outline"}
          disabled={props.disabled}
          aria-pressed={showCustom}
          onClick={() => setCustom(true)}
        >
          Custom date
        </Button>
      </div>
      {showCustom ? (
        <Input
          type="date"
          aria-label="API key deletion date"
          min={new Date(nowMs).toLocaleDateString("en-CA")}
          value={dateValue}
          disabled={props.disabled}
          onChange={(event) => {
            const next = apiKeyCustomExpiry(event.currentTarget.value);
            if (next !== null) {
              setPreset(null);
              props.onChange(next);
            }
          }}
        />
      ) : null}
    </div>
  );
}
