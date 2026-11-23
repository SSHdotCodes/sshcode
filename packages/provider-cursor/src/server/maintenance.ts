import { ProviderDriverKind } from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import {
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const DRIVER = ProviderDriverKind.make("cursor");
const CURSOR_VERSION = /^(20\d{2}\.\d{2}\.\d{2}(?:-[\da-z]+)?)$/i;

/** Read release metadata from the official installer without executing its script. */
export const latestCursorVersion = Effect.fn("latestCursorVersion")(function* () {
  const client = yield* HttpClient.HttpClient;
  return yield* Effect.gen(function* () {
    const response = yield* client.execute(HttpClientRequest.get("https://cursor.com/install"));
    if (response.status !== 200) return null;
    const body = yield* collectUint8StreamText({ stream: response.stream, maxBytes: 128 * 1024 });
    if (body.truncated) return null;
    return (
      body.text.match(
        /https:\/\/downloads\.cursor\.com\/lab\/(20\d{2}\.\d{2}\.\d{2}(?:-[\da-z]+)?)\//i,
      )?.[1] ?? null
    );
  }).pipe(
    Effect.timeout("4 seconds"),
    Effect.orElseSucceed(() => null),
  );
});

/** Cursor's SDK is bundled. This maintains the separately installed local Agent CLI. */
export const resolveCursorMaintenance = Effect.fn("resolveCursorMaintenance")(function* (
  binaryPath: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  let installedVersion: string | null = null;
  const resolver = makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER,
    npmPackageName: null,
    nativeUpdate: { args: ["update"] },
  });
  const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
    {
      resolve: (context) =>
        Effect.gen(function* () {
          if (!context) return yield* resolver.resolve(null);
          const real = context.realCommandPath.replaceAll("\\", "/");
          const nativeVersion = real.match(/\/cursor-agent\/versions\/([^/]+)\/cursor-agent$/)?.[1];
          const brewVersion = real.match(/\/(?:Cellar|Caskroom)\/[^/]+\/([^/]+)\//i)?.[1];
          installedVersion =
            nativeVersion && CURSOR_VERSION.test(nativeVersion)
              ? nativeVersion
              : (brewVersion ?? null);
          const resolved = yield* resolver.resolve(context);
          // The native installer writes under HOME. A wrapper or a binary belonging
          // to another home must not update a different installation by accident.
          const nativeHome = real.split("/.local/share/cursor-agent/versions/")[0];
          const ownsNative = nativeVersion && nativeHome === env.HOME?.replace(/\/$/, "");
          return resolved.update?.lockKey === "cursor-native" && !ownsNative
            ? {
                ...resolved,
                update: null,
                manualUpdateCommand: resolved.update.command,
              }
            : resolved;
        }),
    },
    { binaryPath: binaryPath || "agent", env },
  );
  const latestVersion =
    capabilities.latestVersion === undefined && installedVersion
      ? yield* latestCursorVersion()
      : (capabilities.latestVersion ?? null);
  return {
    ...capabilities,
    latestVersion,
    installedVersion,
  } satisfies ProviderMaintenanceCapabilities & { readonly installedVersion: string | null };
});
