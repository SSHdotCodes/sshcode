import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ArchivedShellSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { v2ThreadShell, v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";
import { expect, it } from "vite-plus/test";

import {
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
} from "./archivedThreads.ts";

it("round-trips environment keys in sorted order", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const key = makeArchivedThreadsEnvironmentKey([envB, envA]);

  expect(parseArchivedThreadsEnvironmentKey(key)).toEqual([envA, envB]);
});

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationV2ArchivedShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])))).toEqual({
    snapshots: [],
    error: "Failed to load archived threads.",
    isLoading: false,
  });

  registry.dispose();
});

it("keeps helpers out of web and phone archived chat snapshots", () => {
  const environmentId = EnvironmentId.make("archive-env");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.success({
          schemaVersion: 1,
          snapshotSequence: 0,
          projects: v2ShellSnapshot.projects,
          threads: [v2ThreadShell, { ...v2ThreadShell, id: ThreadId.make("models:saved") }],
        }),
      ),
    labelPrefix: "test:helpers",
  });
  const registry = AtomRegistry.make();
  const result = registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])));
  expect(result.snapshots[0]?.snapshot.threads.map((thread) => thread.id)).toEqual([
    v2ThreadShell.id,
  ]);
  registry.dispose();
});
