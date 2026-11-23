import { useAtomValue } from "@effect/atom-react";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatSettingsStatusDate } from "../settings/lib/settingsStatusDate";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ConnectionTraceId } from "./ConnectionTraceId";
import { connectionDetailsPresentation, connectionDoctorPresentation } from "./connection-doctor";

export function ConnectionDoctor({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const entry = useAtomValue(environmentCatalog.catalogValueAtom).entries.get(environmentId);
  const stateResult = useAtomValue(environmentCatalog.stateAtom(environmentId));
  const network = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const retry = useAtomCommand(environmentCatalog.retryNow, "connection retry");
  const refreshRelay = useAtomCommand(relayEnvironmentDiscovery.refresh, "relay status refresh");
  const state = Option.getOrElse(AsyncResult.value(stateResult), () => AVAILABLE_CONNECTION_STATE);
  const discovered = discovery.environments.get(environmentId);
  const relayStatus =
    discovered?.availability === "offline" || discovered?.availability === "online"
      ? Option.getOrNull(discovered.status)
      : null;
  const doctor = entry
    ? connectionDoctorPresentation({ entry, state, network, relayStatus })
    : null;
  if (entry === undefined) return null;
  const details = connectionDetailsPresentation({ entry, state });
  return (
    <>
      <SettingsSection title="Connection details">
        <View className="gap-1 px-4 py-3">
          <Text className="text-sm text-foreground">{details.stage}</Text>
          {details.activeRoute ? (
            <Text className="text-sm text-foreground-muted">Route: {details.activeRoute}</Text>
          ) : null}
          {details.retryAt === null ? null : (
            <Text className="text-sm text-foreground-muted">
              Next retry: {formatSettingsStatusDate(details.retryAt)}
            </Text>
          )}
        </View>
      </SettingsSection>
      {doctor === null ? null : (
        <SettingsSection title="Connection doctor">
          <View className="gap-1 px-4 py-3">
            <Text className="text-base font-t3-medium text-foreground">{doctor.summary}</Text>
            <Text className="text-sm text-foreground-muted">{doctor.nextStep}</Text>
          </View>
          {doctor.routes.map((route) => (
            <View key={route.routeId} className="gap-1 px-4 py-3">
              <Text className="text-base font-t3-medium text-foreground">{route.label}</Text>
              <Text className="text-sm text-foreground">{route.summary}</Text>
              {route.nextStep ? (
                <Text className="text-sm text-foreground-muted">{route.nextStep}</Text>
              ) : null}
              {route.detail ? (
                <Text selectable className="text-sm text-foreground-muted">
                  {route.detail}
                  {route.traceId ? <ConnectionTraceId traceId={route.traceId} /> : null}
                </Text>
              ) : null}
            </View>
          ))}
          <SettingsActionRow
            icon="arrow.clockwise"
            label="Try again"
            onPress={() => {
              void retry(environmentId);
              if (doctor.routes.some((route) => route.routeId === "relay")) void refreshRelay();
            }}
          />
        </SettingsSection>
      )}
    </>
  );
}
