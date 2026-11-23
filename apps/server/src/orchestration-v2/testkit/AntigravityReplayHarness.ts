import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { makeAcpAdapterV2 } from "@t3tools/provider-acp/server/adapter";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeAntigravityAcpAdapterFlavor } from "../Adapters/AntigravityAdapterV2.ts";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayRuntime,
  makeAcpReplayCompletenessAssertion,
  type AcpReplayTranscript,
  type AcpReplayTranscriptDecodeError,
} from "../Adapters/AcpAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "./ProviderReplayHarness.ts";

/** Replays a recorded `agy acp` transcript through the Antigravity flavor. */
export const driver = ProviderDriverKind.make("antigravity");
export const instanceId = ProviderInstanceId.make("antigravity");
export const harness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver,
  decodeTranscript: (input) => decodeAcpReplayTranscript(input, driver),
  makeProviderAdapterRegistryLayer: (transcript, options) =>
    ProviderAdapterRegistry.layerFromAdaptersEffect(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "antigravity-steering-replay-" })
          .pipe(Effect.orDie);
        const statusPath = path.join(directory, "status.json");
        const scriptPath = yield* path
          .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
          .pipe(Effect.orDie);
        const selfInvocation = yield* resolveSelfInvocation();
        return [
          yield* makeAcpAdapterV2({
            instanceId,
            selfInvocation,
            flavor: {
              ...makeAntigravityAcpAdapterFlavor({
                instanceId,
                selfInvocation,
                crypto: yield* Crypto.Crypto,
                fileSystem,
                path,
                host: yield* ProviderHost.ProviderHost,
                withProcess: (_stop, task) => task,
                defaultModel: Effect.succeed(undefined),
                makeRuntime: () => Effect.die("replay owns the transport"),
              }),
              makeRuntime: makeAcpReplayRuntime({
                transcript,
                statusPath,
                scriptPath,
                childProcessSpawner,
                fileSystem,
                ...(options?.replayGate === undefined ? {} : { replayGate: options.replayGate }),
              }),
              assertComplete: makeAcpReplayCompletenessAssertion(
                fileSystem,
                statusPath,
                transcript,
              ),
            },
          }),
        ];
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          IdAllocator.layer,
          TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
};
export const request = (method: string): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: { kind: "request", method, params: "<any>" },
});
export const reply = (method: string, result: unknown): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: { kind: "response", method, result },
});
