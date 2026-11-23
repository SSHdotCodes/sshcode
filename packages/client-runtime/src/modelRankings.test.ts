import { expect, it } from "vite-plus/test";
import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ModelRankingsSaveError,
  ServerSettingsError,
  type ModelRankings,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { createModelRankingsEditorState, ModelRankingNoteDraft as Draft } from "./modelRankings.ts";

type Bindings = Parameters<typeof createModelRankingsEditorState>[0];
type SaveResult = Awaited<ReturnType<Bindings["updateSettings"]["run"]>>;
const environmentId = EnvironmentId.make("ranking-client-test");
const rankings: ModelRankings = [
  { id: "review", name: "Review", entries: [], order: [], comparisons: [] },
];
const supportedConfig = Atom.make({ modelRankingsConcurrency: true });

it("keeps acknowledged saves visible until their snapshot arrives and uses the acknowledged base for the next save", async () => {
  const registry = AtomRegistry.make();
  const settings = Atom.make<ServerSettings | null>(DEFAULT_SERVER_SETTINGS);
  const permission = Atom.make(true);
  const response = Promise.withResolvers<SaveResult>();
  const inputs: Parameters<Bindings["updateSettings"]["run"]>[1]["input"][] = [];
  const editor = createModelRankingsEditorState({
    settingsValueAtom: () => settings,
    configValueAtom: () => supportedConfig,
    updateSettings: {
      label: "test",
      permissionAtom: () => permission,
      requiredScopes: () => [AuthSettingsWriteScope],
      run: (_registry, target) => {
        inputs.push(target.input);
        return response.promise;
      },
    },
  });
  const unmount = registry.mount(editor.stateAtom(environmentId));
  try {
    const save = editor.save.run(registry, {
      environmentId,
      input: rankings,
      expectedModelRankings: [],
    });
    expect(registry.get(editor.stateAtom(environmentId))).toMatchObject({
      rankings,
      baseRankings: [],
      saving: true,
    });
    const duplicate = editor.save.run(registry, {
      environmentId,
      input: [],
      expectedModelRankings: [],
    });
    expect(inputs).toEqual([{ patch: { modelRankings: rankings }, expectedModelRankings: [] }]);
    response.resolve(AsyncResult.success({ ...DEFAULT_SERVER_SETTINGS, modelRankings: rankings }));
    await Promise.all([save, duplicate]);
    expect(registry.get(editor.stateAtom(environmentId))).toMatchObject({
      rankings,
      baseRankings: rankings,
      saving: false,
      error: null,
    });
    const state = registry.get(editor.stateAtom(environmentId));
    await editor.save.run(registry, {
      environmentId,
      input: rankings,
      expectedModelRankings: state.baseRankings,
    });
    expect(inputs[1]?.expectedModelRankings).toEqual(rankings);
    registry.set(settings, { ...DEFAULT_SERVER_SETTINGS, modelRankings: rankings });
    expect(registry.get(editor.stateAtom(environmentId)).rankings).toEqual(rankings);
    registry.set(settings, { ...DEFAULT_SERVER_SETTINGS, modelRankings: [] });
    expect(registry.get(editor.stateAtom(environmentId)).rankings).toEqual([]);
    registry.set(permission, false);
    expect(registry.get(editor.stateAtom(environmentId)).canWrite).toBe(false);
  } finally {
    unmount();
    registry.dispose();
  }
});

it("keeps failed edits and their note draft retryable after a delayed failure", async () => {
  const original: ModelRankings = [
    {
      ...rankings[0]!,
      entries: [
        {
          id: "model",
          label: "Model",
          family: "codex",
          note: "Original note",
        },
      ],
    },
  ];
  const edited: ModelRankings = [
    { ...original[0]!, entries: [{ ...original[0]!.entries[0]!, note: "A note worth keeping" }] },
  ];
  const registry = AtomRegistry.make();
  const settings = Atom.make({ ...DEFAULT_SERVER_SETTINGS, modelRankings: original });
  const response = Promise.withResolvers<SaveResult>();
  let writes = 0;
  const editor = createModelRankingsEditorState({
    settingsValueAtom: () => settings,
    configValueAtom: () => supportedConfig,
    updateSettings: {
      label: "test",
      permissionAtom: () => Atom.make(true),
      requiredScopes: () => [AuthSettingsWriteScope],
      run: async (_registry, target) => {
        writes++;
        expect(target.input.expectedModelRankings).toEqual(original);
        return writes === 1
          ? response.promise
          : AsyncResult.success({ ...DEFAULT_SERVER_SETTINGS, modelRankings: edited });
      },
    },
  });
  const unmount = registry.mount(editor.stateAtom(environmentId));
  const sourceNote = () =>
    registry.get(editor.stateAtom(environmentId)).baseRankings[0]?.entries[0]?.note ?? "";
  try {
    let draft = Draft.change(Draft.create(sourceNote()), "A note worth keeping");
    const save = editor.save.run(registry, {
      environmentId,
      input: edited,
      expectedModelRankings: original,
    });
    expect(registry.get(editor.stateAtom(environmentId))).toMatchObject({
      rankings: edited,
      baseRankings: original,
      saving: true,
    });
    // Note fields receive the acknowledged base, never an optimistic note.
    draft = Draft.receive(draft, sourceNote());
    response.resolve(
      AsyncResult.failure(
        Cause.fail(
          new ServerSettingsError({
            settingsPath: "/test/settings.json",
            operation: "write-file",
            cause: new Error("test"),
          }),
        ),
      ),
    );
    await save;
    expect(registry.get(editor.stateAtom(environmentId))).toMatchObject({
      rankings: edited,
      baseRankings: original,
      saving: false,
      unsaved: true,
      error: "Server settings write-file failed at /test/settings.json.",
    });
    draft = Draft.receive(draft, sourceNote());
    expect(draft.text).toBe("A note worth keeping");
    expect(Draft.commitValue(draft)).toBe("A note worth keeping");
    const retry = registry.get(editor.stateAtom(environmentId));
    await editor.save.run(registry, {
      environmentId,
      input: retry.rankings,
      expectedModelRankings: retry.baseRankings,
    });
    expect(writes).toBe(2);
    expect(registry.get(editor.stateAtom(environmentId))).toMatchObject({
      rankings: edited,
      baseRankings: edited,
      unsaved: false,
      error: null,
    });
    draft = Draft.receive(draft, sourceNote());
    expect(draft.text).toBe("A note worth keeping");
    expect(Draft.commitValue(draft)).toBeNull();
  } finally {
    unmount();
    registry.dispose();
  }
});

it("sends the rendered base even if a newer snapshot arrives before saving, and retains a conflict until discarded", async () => {
  const registry = AtomRegistry.make();
  const settings = Atom.make(DEFAULT_SERVER_SETTINGS);
  const remoteRankings = [{ ...rankings[0]!, name: "Edited on mobile" }];
  const response = Promise.withResolvers<SaveResult>();
  const editor = createModelRankingsEditorState({
    settingsValueAtom: () => settings,
    configValueAtom: () => supportedConfig,
    updateSettings: {
      label: "test",
      permissionAtom: () => Atom.make(true),
      requiredScopes: () => [AuthSettingsWriteScope],
      run: (_registry, target) => {
        expect(target.input.expectedModelRankings).toEqual([]);
        return response.promise;
      },
    },
  });
  const unmount = registry.mount(editor.stateAtom(environmentId));
  try {
    const rendered = registry.get(editor.stateAtom(environmentId));
    registry.set(settings, { ...DEFAULT_SERVER_SETTINGS, modelRankings: remoteRankings });
    const save = editor.save.run(registry, {
      environmentId,
      input: rankings,
      expectedModelRankings: rendered.baseRankings,
    });
    response.resolve(
      AsyncResult.failure(Cause.fail(new ModelRankingsSaveError({ reason: "conflict" }))),
    );
    await save;
    expect(registry.get(editor.stateAtom(environmentId))).toMatchObject({
      rankings,
      baseRankings: [],
      unsaved: true,
      saving: false,
      conflict: true,
    });
    registry.set(settings, {
      ...DEFAULT_SERVER_SETTINGS,
      branchNamePrefix: "new snapshot",
      modelRankings: remoteRankings,
    });
    expect(registry.get(editor.stateAtom(environmentId)).rankings).toEqual(rankings);
    const beforeDiscard = registry.get(editor.stateAtom(environmentId)).draftVersion;
    await editor.discard.run(registry, { environmentId });
    expect(registry.get(editor.stateAtom(environmentId)).draftVersion).toBe(beforeDiscard + 1);
    expect(registry.get(editor.stateAtom(environmentId))).toMatchObject({
      rankings: remoteRankings,
      baseRankings: remoteRankings,
      unsaved: false,
      conflict: false,
      error: null,
    });
  } finally {
    unmount();
    registry.dispose();
  }
});

it("refuses unsafe saves to older hosts even when they support rankings and grant settings access", async () => {
  const registry = AtomRegistry.make();
  let writes = 0;
  const editor = createModelRankingsEditorState({
    settingsValueAtom: () => Atom.make(DEFAULT_SERVER_SETTINGS),
    configValueAtom: () => Atom.make({}),
    updateSettings: {
      label: "test",
      permissionAtom: () => Atom.make(true),
      requiredScopes: () => [AuthSettingsWriteScope],
      run: async () => {
        writes++;
        return AsyncResult.success(DEFAULT_SERVER_SETTINGS);
      },
    },
  });
  const unmount = registry.mount(editor.stateAtom(environmentId));
  try {
    expect(registry.get(editor.stateAtom(environmentId)).canWrite).toBe(false);
    const result = await editor.save.run(registry, {
      environmentId,
      input: rankings,
      expectedModelRankings: [],
    });
    expect(result._tag).toBe("Failure");
    expect(writes).toBe(0);
    expect(registry.get(editor.stateAtom(environmentId))).toMatchObject({
      rankings,
      unsaved: true,
      saving: false,
      error: "Update this environment to save model family rankings safely across clients.",
    });
  } finally {
    unmount();
    registry.dispose();
  }
});

function createAcknowledgmentHarness() {
  const snapshots = Array.from({ length: 6 }, (_, index): ModelRankings => [
    { ...rankings[0]!, name: `R${index}` },
  ]);
  const registry = AtomRegistry.make();
  const settings = Atom.make({ ...DEFAULT_SERVER_SETTINGS, modelRankings: snapshots[0]! });
  const requests: Array<{
    input: Parameters<Bindings["updateSettings"]["run"]>[1]["input"];
    response: ReturnType<typeof Promise.withResolvers<SaveResult>>;
  }> = [];
  const editor = createModelRankingsEditorState({
    settingsValueAtom: () => settings,
    configValueAtom: () => supportedConfig,
    updateSettings: {
      label: "test",
      permissionAtom: () => Atom.make(true),
      requiredScopes: () => [AuthSettingsWriteScope],
      run: (_registry, target) => {
        const response = Promise.withResolvers<SaveResult>();
        requests.push({ input: target.input, response });
        return response.promise;
      },
    },
  });
  const unmount = registry.mount(editor.stateAtom(environmentId));
  const read = () => registry.get(editor.stateAtom(environmentId));
  const stream = (index: number) =>
    registry.set(settings, {
      ...DEFAULT_SERVER_SETTINGS,
      // RPC and stream snapshots are independently decoded objects.
      modelRankings: structuredClone(snapshots[index]!),
    });
  const save = (index: number) =>
    editor.save.run(registry, {
      environmentId,
      input: snapshots[index]!,
      expectedModelRankings: read().baseRankings,
    });
  const acknowledge = (index: number) =>
    requests.at(-1)!.response.resolve(
      AsyncResult.success({
        ...DEFAULT_SERVER_SETTINGS,
        modelRankings: snapshots[index]!,
      }),
    );
  const expectSnapshot = (index: number) =>
    expect(read()).toMatchObject({
      rankings: snapshots[index],
      baseRankings: snapshots[index],
      saving: false,
      error: null,
    });
  return {
    snapshots,
    requests,
    read,
    stream,
    save,
    acknowledge,
    expectSnapshot,
    close: () => {
      unmount();
      registry.dispose();
    },
  };
}

it("keeps the second acknowledgment when the first streamed save arrives before its response", async () => {
  const h = createAcknowledgmentHarness();
  try {
    const first = h.save(1);
    h.acknowledge(1);
    await first;
    const second = h.save(2);
    h.stream(1);
    expect(h.read()).toMatchObject({
      rankings: h.snapshots[2],
      baseRankings: h.snapshots[1],
      saving: true,
    });
    h.acknowledge(2);
    await second;
    h.expectSnapshot(2);
    const third = h.save(3);
    expect(h.requests.at(-1)!.input.expectedModelRankings).toEqual(h.snapshots[2]);
    h.acknowledge(3);
    await third;
    h.expectSnapshot(3);
  } finally {
    h.close();
  }
});

it("keeps three acknowledged edits through older stream snapshots and releases their history on catch-up", async () => {
  const h = createAcknowledgmentHarness();
  try {
    for (const index of [1, 2, 3]) {
      const saved = h.save(index);
      expect(h.requests.at(-1)!.input.expectedModelRankings).toEqual(h.snapshots[index - 1]);
      h.acknowledge(index);
      await saved;
      h.expectSnapshot(index);
    }
    h.stream(1);
    h.expectSnapshot(3);
    h.stream(2);
    h.expectSnapshot(3);
    h.stream(3);
    h.expectSnapshot(3);
    // After catch-up, an external edit restoring an old value is no longer a delayed local save.
    const fourth = h.save(4);
    h.stream(1);
    h.acknowledge(4);
    await fourth;
    h.expectSnapshot(1);
  } finally {
    h.close();
  }
});

it.each([
  { count: 1, beforeResponse: true },
  { count: 3, beforeResponse: true },
  { count: 3, beforeResponse: false },
])(
  "lets an unknown newer external snapshot supersede $count local acknowledgments (before response: $beforeResponse)",
  async ({ count, beforeResponse }) => {
    const h = createAcknowledgmentHarness();
    try {
      for (let index = 1; index < count; index++) {
        const saved = h.save(index);
        h.acknowledge(index);
        await saved;
      }
      const pending = h.save(count);
      if (beforeResponse) h.stream(5);
      h.acknowledge(count);
      await pending;
      if (!beforeResponse) h.stream(5);
      h.expectSnapshot(5);
      // Supersession also drops the older local chain, even without stream catch-up.
      const next = h.save(4);
      expect(h.requests.at(-1)!.input.expectedModelRankings).toEqual(h.snapshots[5]);
      h.stream(1);
      h.acknowledge(4);
      await next;
      h.expectSnapshot(1);
    } finally {
      h.close();
    }
  },
);
