import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { fetchAntigravityReleaseAsset } from "./antigravityRelease.ts";

it.effect.each([
  {
    archive: "https://dl.google.com/agy-extensions/releases/macos/latest.zip",
    sha256: "a".repeat(64),
    expected: "3.2.1",
  },
  { archive: "https://untrusted.test/latest.zip", sha256: "a".repeat(64), expected: null },
  {
    archive: "https://dl.google.com/agy-extensions/releases/macos/latest.zip",
    sha256: undefined,
    expected: null,
  },
])(
  "reads registry releases and requires Google's download host and a checksum",
  ({ archive, sha256, expected }) =>
    fetchAntigravityReleaseAsset("darwin", "arm64").pipe(
      Effect.tap((asset) => Effect.sync(() => expect(asset?.version ?? null).toBe(expected))),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                agents: [
                  { id: "unrelated", version: "1.0.0", distribution: {} },
                  {
                    id: "antigravity-acp",
                    version: "3.2.1",
                    distribution: {
                      binary: {
                        "darwin-aarch64": { archive, sha256, cmd: "./agy_acp_server.par" },
                      },
                    },
                  },
                ],
              }),
            ),
          ),
        ),
      ),
    ),
);
