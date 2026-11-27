import { useAtomValue } from "@effect/atom-react";
import type { ExecutionEnvironmentPlatform } from "@t3tools/contracts";
import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliReleaseTagUrl,
} from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";

/** The part of GitHub's release record that lists what servers can download. */
const isReleaseWithAssets = Schema.is(
  Schema.Struct({ assets: Schema.Array(Schema.Struct({ name: Schema.String })) }),
);
const NO_ASSETS: ReadonlySet<string> = new Set();

/**
 * The asset names of GitHub release `v<version>` when it carries server downloads (its checksum
 * file among them). A missing release, or one without them (such as a desktop-only release), is
 * empty; network and API errors stay unknown. Both re-check every few minutes, so a release that
 * lands later shows up without a reload. Browsers cannot read the checksum file itself (GitHub's
 * downloads send no CORS headers), so the asset list stands in for it: the release workflow
 * attaches each archive beside the checksum file that lists it.
 */
export const serverReleaseAssetsAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      const response = yield* HttpClient.get(cliReleaseTagUrl(version));
      if (response.status === 404) return NO_ASSETS;
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
      );
      if (!isReleaseWithAssets(body)) return NO_ASSETS;
      const names: ReadonlySet<string> = new Set(body.assets.map((asset) => asset.name));
      return names.has(CLI_RELEASE_CHECKSUMS_FILE) ? names : NO_ASSETS;
    }).pipe(
      // Tracing headers would make the browser send a CORS preflight for a plain read.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`server-release-assets:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(NO_ASSETS)).pipe(
  Atom.withLabel("server-release-assets:none"),
);

/** The release's server downloads once GitHub answers, or null while unknown. */
export function useServerReleaseAssets(version: string | null): ReadonlySet<string> | null {
  const result = useAtomValue(version ? serverReleaseAssetsAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => null);
}

/**
 * Whether a server on `platform` can download `version`: the release has its platform's archive
 * beside the checksum file, which the installer requires. Null while the release is unknown, or
 * when the server's platform has no archive name to look for.
 */
export function serverDownloadReady(
  assets: ReadonlySet<string> | null,
  version: string,
  platform: ExecutionEnvironmentPlatform | undefined,
): boolean | null {
  if (assets === null) return null;
  if (!assets.has(CLI_RELEASE_CHECKSUMS_FILE)) return false;
  if (platform === undefined || platform.os === "unknown") return null;
  const key = cliArchivePlatformKey(
    platform.os === "windows" ? "win32" : platform.os,
    platform.arch,
  );
  return key === undefined ? null : assets.has(cliArchiveFileName(version, key));
}
