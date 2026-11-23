import { AuthPreviewOperateScope, type BrowserProfile } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { useClientSettings, useClientSettingsHydrated } from "~/hooks/useSettings";
import { useServerConfigs } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

const selectProfiles = (settings: { readonly browserProfiles: ReadonlyArray<BrowserProfile> }) =>
  settings.browserProfiles;
const selectDefaultProfileId = (settings: { readonly browserDefaultProfileId: string }) =>
  settings.browserDefaultProfileId;

/**
 * Tells each environment that hosts browser tabs which profiles this client
 * has, so agents can open tabs under them. Profiles live in client settings;
 * the server keeps only the latest report in memory. A reconnect brings a new
 * server config, which sends the report again.
 */
export function BrowserProfileReporter() {
  const hydrated = useClientSettingsHydrated();
  const profiles = useClientSettings(selectProfiles);
  const defaultProfileId = useClientSettings(selectDefaultProfileId);
  const { environments, presentationById } = useEnvironments();
  const serverConfigs = useServerConfigs();
  const operable = useEnvironmentsWithScope(environments, AuthPreviewOperateScope);
  const report = useAtomCommand(previewEnvironment.reportProfiles, { reportFailure: false });
  // The report is best effort: a disconnected environment cannot host tabs,
  // and its reconnect delivers a fresh server config that re-sends the report.
  // Sending while it is disconnected only surfaces "not connected" again on
  // every settings or config change.
  const connectedEnvironmentIds = useMemo(
    () =>
      new Set(
        [...presentationById]
          .filter(([, presentation]) => presentation.connection.phase === "connected")
          .map(([environmentId]) => environmentId),
      ),
    [presentationById],
  );

  useEffect(() => {
    if (!hydrated) return;
    for (const [environmentId, config] of serverConfigs) {
      if (
        !config.environment.capabilities.serverBrowser ||
        !operable.has(environmentId) ||
        !connectedEnvironmentIds.has(environmentId)
      ) {
        continue;
      }
      void report({ environmentId, input: { profiles, defaultProfileId } });
    }
  }, [
    connectedEnvironmentIds,
    defaultProfileId,
    hydrated,
    operable,
    profiles,
    report,
    serverConfigs,
  ]);

  return null;
}
