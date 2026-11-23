import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

export function SearchIndexSettings() {
  const { connectedEnvironments } = useSettingsScope();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rebuild = useAtomCommand(orchestrationEnvironment.rebuildSearchIndex);
  const rows = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          connectedEnvironments.flatMap((environment) => {
            if (!environment.serverConfig?.threadSearchProgressive) return [];
            const query = orchestrationEnvironment.searchIndexStatus({
              environmentId: environment.environmentId,
              input: {},
            });
            const result = get(query);
            return [
              {
                environment,
                query,
                status: result._tag === "Success" ? result.value : null,
                unavailable: result._tag === "Failure",
                allowed: get(
                  orchestrationEnvironment.rebuildSearchIndex.permissionAtom(
                    environment.environmentId,
                  ),
                ),
              },
            ];
          }),
        ),
      [connectedEnvironments],
    ),
  );
  if (!rows.length) return null;
  return (
    <SettingsSection id="search-index" title="Search">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {rows.map((row) => (
        <SettingsRow
          {...searchableSetting("search-index")}
          key={row.environment.environmentId}
          title={rows.length > 1 ? row.environment.label : "Chat search"}
          description={
            <>
              {row.status
                ? `Indexed ${row.status.indexedMessages.toLocaleString()} of ${row.status.totalMessages.toLocaleString()} messages · ${row.status.model} · ${row.status.modelStatus === "unavailable" ? "Keyword only" : row.status.modelStatus === "ready" ? "Meaning search ready" : "Checking model"}${row.status.paused ? " · Paused" : ""}`
                : row.unavailable
                  ? "Search status unavailable. Reconnect and try again."
                  : "Loading search status…"}
              <br />
              Search runs on the connected machine and updates in the background.
            </>
          }
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={!row.allowed || pending}
              onClick={async () => {
                setPending(true);
                setError(null);
                try {
                  const result = await rebuild({
                    environmentId: row.environment.environmentId,
                    input: {},
                  });
                  if (result._tag === "Success") appAtomRegistry.refresh(row.query);
                  else if (!isAtomCommandInterrupted(result))
                    setError("Could not rebuild the search index. Reconnect and try again.");
                } finally {
                  setPending(false);
                }
              }}
            >
              Rebuild index
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
