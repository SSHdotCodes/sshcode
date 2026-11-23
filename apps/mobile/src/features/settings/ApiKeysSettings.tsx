import { useAtomValue } from "@effect/atom-react";
import type { ApiKeyMetadata, EnvironmentId } from "@t3tools/contracts";
import { apiKeyExpiryLabel } from "@t3tools/client-runtime/secret-request";
import { useState } from "react";
import { Alert, View } from "react-native";
import type { AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ListRow } from "../../components/ListRow";
import { ListRowLayout } from "../../components/ListRowLayout";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ApiKeyExpiryPicker } from "../threads/ApiKeyExpiryPicker";
import { RequestActionButton } from "../threads/RequestActionButton";
import { SettingsActionRow } from "./components/SettingsActionRow";

const KEY_ICON: AppSymbolName = { ios: "key.horizontal", android: "lock" };

export function ApiKeysSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  // The list refreshes every minute and after each change, so it needs no refresh control.
  const keys = useEnvironmentQuery(
    serverEnvironment.apiKeys({ environmentId, input: { action: "list" } }),
  );
  if (keys.error) {
    return (
      <ListRow
        icon={KEY_ICON}
        label="Could not load API keys"
        description="Tap to try again."
        onPress={keys.refresh}
      />
    );
  }
  if (keys.data === null) {
    return <ListRowLayout icon={KEY_ICON} label="API keys" description="Loading saved keys…" />;
  }
  if (keys.data.length === 0) {
    return (
      <ListRowLayout
        icon={KEY_ICON}
        label="No saved API keys"
        description="Agents ask for a key when they need one. Keys stay in the Keychain and are never shown."
      />
    );
  }
  return keys.data.map((item) => (
    <ApiKeyRow
      key={`${item.id}:${item.expiresAt}`}
      item={item}
      environmentId={environmentId}
      refresh={keys.refresh}
    />
  ));
}

function ApiKeyRow(props: {
  readonly item: ApiKeyMetadata;
  readonly environmentId: EnvironmentId;
  readonly refresh: () => void;
}) {
  const { item, environmentId } = props;
  const [openedAt] = useState(Date.now);
  const [editing, setEditing] = useState(false);
  const [expiresAt, setExpiresAt] = useState(item.expiresAt);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"update" | "delete" | null>(null);
  const options = { reportFailure: false, reportDefect: false };
  const update = useAtomCommand(serverEnvironment.updateApiKeyExpiry, options);
  const remove = useAtomCommand(serverEnvironment.deleteApiKey, options);
  const allowed = useAtomValue(serverEnvironment.updateApiKeyExpiry.permissionAtom(environmentId));
  const act = async (action: "update" | "delete") => {
    if (busy || !allowed) return;
    setBusy(true);
    setFailed(null);
    try {
      const result = await (action === "delete"
        ? remove({ environmentId, input: { action: "delete", id: item.id } })
        : update({ environmentId, input: { action: "update", id: item.id, expiresAt } }));
      if (result._tag === "Success") {
        setEditing(false);
        props.refresh();
      } else setFailed(action);
    } finally {
      setBusy(false);
    }
  };
  // The value lives only in the Keychain, so a deleted key cannot come back.
  const confirmDelete = () =>
    Alert.alert(`Delete ${item.name}?`, "Agents will have to ask for this key again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void act("delete") },
    ]);
  return (
    <View>
      <ListRow
        icon={KEY_ICON}
        label={`${item.label} · ${item.name}`}
        description={`${item.scope === "all" ? "All sessions" : "This chat only"} · ${apiKeyExpiryLabel(item.expiresAt)}`}
        disabled={!allowed}
        onPress={() => {
          setExpiresAt(item.expiresAt);
          setEditing(!editing);
        }}
      />
      {editing ? (
        <>
          <View className="gap-3 px-4 pb-1">
            <ApiKeyExpiryPicker value={expiresAt} onChange={setExpiresAt} disabled={busy} />
            <RequestActionButton
              label="Save expiry"
              tone="secondary"
              disabled={
                busy ||
                expiresAt === item.expiresAt ||
                (expiresAt !== null && expiresAt <= openedAt)
              }
              onPress={() => void act("update")}
            />
            {failed ? (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {failed === "delete"
                  ? "Could not delete this key. Try again."
                  : "Could not update this key. Try again."}
              </Text>
            ) : null}
          </View>
          {/* A full-width row like every other action in Settings, not inset
              inside the editor's padding. */}
          <SettingsActionRow
            icon="trash"
            label="Delete key"
            tone="danger"
            disabled={busy}
            loading={busy}
            onPress={confirmDelete}
          />
        </>
      ) : null}
    </View>
  );
}
