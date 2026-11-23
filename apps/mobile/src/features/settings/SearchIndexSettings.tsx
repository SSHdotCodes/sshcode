import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";

export function SearchIndexSettings() {
  const configs = useServerConfigs();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rebuild = useAtomCommand(orchestrationEnvironment.rebuildSearchIndex);
  const rows = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          [...configs].flatMap(([environmentId, config]) => {
            if (!config.threadSearchProgressive) return [];
            const result = get(
              orchestrationEnvironment.searchIndexStatus({ environmentId, input: {} }),
            );
            return [
              {
                environmentId,
                status: result._tag === "Success" ? result.value : null,
                unavailable: result._tag === "Failure",
                allowed: get(
                  orchestrationEnvironment.rebuildSearchIndex.permissionAtom(environmentId),
                ),
              },
            ];
          }),
        ),
      [configs],
    ),
  );
  if (!rows.length) return null;
  return (
    <SettingsSection title="Search">
      {error ? (
        <Text accessibilityRole="alert" className="px-4 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {rows.map((row) => (
        <View key={row.environmentId}>
          <Text className="px-4 pt-3 text-sm text-foreground-muted">
            {row.status
              ? `Indexed ${row.status.indexedMessages.toLocaleString()} of ${row.status.totalMessages.toLocaleString()} messages · ${row.status.model} · ${row.status.modelStatus === "unavailable" ? "Keyword only" : row.status.modelStatus === "ready" ? "Ready" : "Checking model"}${row.status.paused ? " · Paused" : ""}`
              : row.unavailable
                ? "Search status unavailable. Reconnect and try again."
                : "Loading search status…"}
          </Text>
          <Text className="px-4 pt-2 text-sm text-foreground-muted">
            Search runs on the connected machine and updates in the background.
          </Text>
          <SettingsActionRow
            label="Rebuild index"
            icon="arrow.clockwise"
            disabled={!row.allowed || pending}
            onPress={async () => {
              setPending(true);
              setError(null);
              try {
                const result = await rebuild({ environmentId: row.environmentId, input: {} });
                if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
                  setError("Could not rebuild the search index. Reconnect and try again.");
              } finally {
                setPending(false);
              }
            }}
          />
        </View>
      ))}
    </SettingsSection>
  );
}
