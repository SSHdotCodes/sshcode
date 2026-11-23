import { useAtomValue } from "@effect/atom-react";
import type { ApiKeyMetadata, EnvironmentId } from "@t3tools/contracts";
import { apiKeyExpiryLabel } from "@t3tools/client-runtime/secret-request";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ApiKeyExpiryPicker } from "../chat/ApiKeyExpiryPicker";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function ApiKeysSettings() {
  const { connectedEnvironments } = useSettingsScope();
  return (
    <SettingsSection id="api-keys" title="API keys">
      {connectedEnvironments.map((environment) => (
        <EnvironmentApiKeys
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={connectedEnvironments.length > 1 ? environment.label : null}
        />
      ))}
    </SettingsSection>
  );
}

function EnvironmentApiKeys({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  /** Shown only when several environments list their keys together. */
  readonly label: string | null;
}) {
  // The list refreshes every minute and after each change, so it needs no refresh button.
  const keys = useEnvironmentQuery(
    serverEnvironment.apiKeys({ environmentId, input: { action: "list" } }),
  );
  const where = label === null ? "" : ` on ${label}`;
  if (keys.error) {
    return (
      <SettingsRow
        title="Could not load API keys"
        description={`Check the connection${where} and try again.`}
        control={
          <Button size="sm" variant="outline" onClick={keys.refresh}>
            Retry
          </Button>
        }
      />
    );
  }
  if (keys.data === null) {
    return <SettingsRow title="API keys" description="Loading saved keys…" />;
  }
  if (keys.data.length === 0) {
    return (
      <SettingsRow
        title={`No saved keys${where}`}
        description="Agents ask for a key when they need one. Keys stay in the Keychain and are never shown here."
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
  const [error, setError] = useState(false);
  const options = { reportFailure: false, reportDefect: false };
  const update = useAtomCommand(serverEnvironment.updateApiKeyExpiry, options);
  const remove = useAtomCommand(serverEnvironment.deleteApiKey, options);
  const allowed = useAtomValue(serverEnvironment.updateApiKeyExpiry.permissionAtom(environmentId));
  const act = async (action: "update" | "delete") => {
    if (busy || !allowed) return false;
    setBusy(true);
    setError(false);
    try {
      const result = await (action === "delete"
        ? remove({ environmentId, input: { action: "delete", id: item.id } })
        : update({ environmentId, input: { action: "update", id: item.id, expiresAt } }));
      if (result._tag === "Success") props.refresh();
      else setError(true);
      return result._tag === "Success";
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      title={
        <span className="wrap-anywhere">
          {item.label}{" "}
          <span className="font-mono text-xs font-normal text-muted-foreground">{item.name}</span>
        </span>
      }
      description={`${item.scope === "all" ? "All sessions" : "This chat only"} · ${apiKeyExpiryLabel(item.expiresAt)}`}
      status={
        error ? (
          <span role="alert" className="text-destructive">
            Could not update this key. Try again.
          </span>
        ) : undefined
      }
      control={
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !allowed}
            aria-expanded={editing}
            onClick={() => {
              setExpiresAt(item.expiresAt);
              setEditing(!editing);
            }}
          >
            Change expiry
          </Button>
          <Button
            size="icon-sm"
            variant="ghost-destructive"
            aria-label={`Delete ${item.label} key`}
            disabled={busy || !allowed}
            onClick={() => void act("delete")}
          >
            <Trash2Icon />
          </Button>
        </>
      }
    >
      {editing ? (
        <div className="flex flex-col gap-3 pt-1 pb-3">
          <ApiKeyExpiryPicker value={expiresAt} onChange={setExpiresAt} disabled={busy} />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={
                busy ||
                expiresAt === item.expiresAt ||
                (expiresAt !== null && expiresAt <= openedAt)
              }
              onClick={() =>
                void act("update").then((saved) => {
                  if (saved) setEditing(false);
                })
              }
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </SettingsRow>
  );
}
