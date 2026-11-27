import {
  AuthEnvironmentMaintainScope,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ThreadId,
  AuthOrchestrationOperateScope,
  ORCHESTRATION_V2_WS_METHODS,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Stream from "effect/Stream";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("requires owner settings access to record Auto model feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverRecordAutoModelFeedback)).toBe(
      AuthSettingsWriteScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverDecideAutoModelTask)).toBe(
      AuthSettingsWriteScope,
    );
  });
  it.effect("requires the same provider-management grant as key settings", () =>
    Effect.gen(function* () {
      let writes = 0;
      const credentialGroup = WsRpcGroup.omit(
        ...Array.from(WsRpcGroup.requests.keys()).filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.serverReplaceProviderCredential
          > => tag !== WS_METHODS.serverReplaceProviderCredential,
        ),
      );
      const handlers = credentialGroup.toLayerHandler(
        WS_METHODS.serverReplaceProviderCredential,
        () =>
          Effect.sync(() => {
            writes++;
            return { updatedInstanceIds: [] };
          }),
      );
      const denied = yield* RpcTest.makeClient(credentialGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            handlers,
            RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
          ),
        ),
      );
      expect(
        yield* denied[WS_METHODS.serverReplaceProviderCredential]({
          credentialRef: "opaque-ref",
          value: "test-only-key",
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(writes).toBe(0);
      const allowed = yield* RpcTest.makeClient(credentialGroup).pipe(
        Effect.provide(
          Layer.mergeAll(handlers, RpcAuthorization.layer([AuthProvidersManageScope])),
        ),
      );
      yield* allowed[WS_METHODS.serverReplaceProviderCredential]({
        credentialRef: "opaque-ref",
        value: "test-only-key",
      });
      expect(writes).toBe(1);
    }).pipe(Effect.scoped),
  );
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("lets an orchestration reader load the agent tool catalog", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetAgentTools)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("lets readers inspect computer control and protects takeover and setup", () => {
    for (const method of [WS_METHODS.computerStatus, WS_METHODS.subscribeComputerUse]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    for (const method of [WS_METHODS.computerStop, WS_METHODS.computerResume]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
    expect(requiredScopeForRpcMethod(WS_METHODS.computerSetup)).toBe(AuthSettingsWriteScope);
  });

  it("requires operate access to stop a workflow", () => {
    expect(requiredScopeForRpcMethod(ORCHESTRATION_V2_WS_METHODS.stopWorkflow)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthEnvironmentMaintainScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows note reads while protecting mutations with the operate grant", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.notesSubscribe)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.notesMutate)).toBe(AuthOrchestrationOperateScope);
  });

  it("allows run evidence reads and requires operate access to rate a subagent", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.subagentRankingsSubscribe)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subagentRankingsToggleThumb)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("allows scheduled run history and sample previews with read scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.scheduledTasksListRuns)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.scheduledTasksPreviewWebhook)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("separates team board read and post permissions", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.teamBoardSubscribe)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.teamBoardPost)).toBe(AuthOrchestrationOperateScope);
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("authorizes native session discovery for readers and individual imports for operators", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.nativeSessionsDiscover)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.nativeSessionsPreview)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.nativeSessionsOpen)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("lets readers see Terminal handoffs and requires operate permission to open or bring back", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.terminalHandoffStatus)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.terminalHandoffOpen)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.terminalHandoffReturn)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("allows Remote Control readers to observe but requires operate permission for CLI input", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.claudeRcSessions)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.claudeRcWatch)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.claudeRcCommand)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires write access to import agent session history", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsScan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsImport)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates ACP Registry discovery from provisioning", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverSearchAcpRegistry)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareAcpRegistryAgent)).toBe(
      AuthProvidersManageScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverUninstallAcpRegistryManagedBinary)).toBe(
      AuthProvidersManageScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverAcceptAcpRegistryUrlAuth)).toBe(
      AuthProvidersManageScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverListAcpRegistrySessions)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverImportAcpRegistrySession)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverLogoutAcpRegistry)).toBe(
      AuthProvidersManageScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsChecks)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("requires source control writes to start, retry, or cancel project clones", () => {
    for (const method of [
      WS_METHODS.projectCloneStart,
      WS_METHODS.projectCloneRetry,
      WS_METHODS.projectCloneCancel,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSourceControlWriteScope);
    }
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeProjectClones)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("separates viewing pull request file progress from writing it", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsFilesViewed)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsSetFilesViewed)).toBe(
      AuthSourceControlWriteScope,
    );
  });

  it("separates preview control from observation", () => {
    for (const method of [
      WS_METHODS.previewOpen,
      WS_METHODS.previewNavigate,
      WS_METHODS.previewResize,
      WS_METHODS.previewRefresh,
      WS_METHODS.previewClose,
      WS_METHODS.previewReportStatus,
      WS_METHODS.previewAdjust,
      WS_METHODS.previewClearProfile,
      WS_METHODS.previewReportProfiles,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthPreviewOperateScope);
    }
    for (const method of [
      WS_METHODS.previewList,
      WS_METHODS.subscribePreviewEvents,
      WS_METHODS.subscribeDiscoveredLocalServers,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [
      WS_METHODS.terminalObserve,
      WS_METHODS.subscribeTerminalEvents,
      WS_METHODS.subscribeTerminalMetadata,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalRestart,
      WS_METHODS.terminalClose,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
    {
      scopes: [AuthOrchestrationReadScope, AuthDiagnosticsReadScope],
      missing: AuthEnvironmentMaintainScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({
        patch: {},
        providerInstanceMutation,
        expectedModelRankings: [],
      });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "requires settings access for guarded ranking writes even alongside a provider mutation",
    () =>
      Effect.gen(function* () {
        let handled = 0;
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
                Effect.sync(() => {
                  handled++;
                  return DEFAULT_SERVER_SETTINGS;
                }),
              ),
              RpcAuthorization.layer([AuthProvidersManageScope]),
            ),
          ),
        );
        for (const mutation of [undefined, providerInstanceMutation]) {
          expect(
            yield* client[WS_METHODS.serverUpdateSettings]({
              patch: { modelRankings: [] },
              expectedModelRankings: [],
              ...(mutation ? { providerInstanceMutation: mutation } : {}),
            }).pipe(Effect.flip),
          ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
        }
        expect(handled).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "allows guarded rankings with settings access but still requires provider access for mixed writes",
    () =>
      Effect.gen(function* () {
        let handled = 0;
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
                Effect.sync(() => {
                  handled++;
                  return DEFAULT_SERVER_SETTINGS;
                }),
              ),
              RpcAuthorization.layer([AuthSettingsWriteScope]),
            ),
          ),
        );
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { modelRankings: [] },
          expectedModelRankings: [],
        });
        expect(handled).toBe(1);
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: { modelRankings: [] },
            expectedModelRankings: [],
            providerInstanceMutation,
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
        expect(handled).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("API key metadata is readable but expiry and deletion require settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.apiKeysManage> =>
          tag !== WS_METHODS.apiKeysManage,
      ),
    );
    const handled: string[] = [];
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.apiKeysManage, (input) =>
            Effect.sync(() => {
              handled.push(input.action);
              return [];
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.apiKeysManage]({ action: "list" })).toEqual([]);
    expect(
      yield* client[WS_METHODS.apiKeysManage]({ action: "delete", id: "fake-key" }).pipe(
        Effect.flip,
      ),
    ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
    expect(
      yield* client[WS_METHODS.apiKeysManage]({
        action: "update",
        id: "fake-key",
        expiresAt: null,
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
    expect(handled).toEqual(["list"]);
  }).pipe(Effect.scoped),
);

it.effect("withholds outside-agent codes and commands from every incomplete grant", () =>
  Effect.gen(function* () {
    const methods = [WS_METHODS.outsideAgentsSubscribe, WS_METHODS.outsideAgentsCommand] as const;
    const group = WsRpcGroup.omit(
      ...Array.from(WsRpcGroup.requests.keys()).filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof methods)[number]> =>
          !(methods as readonly string[]).includes(tag),
      ),
    );
    let calls = 0;
    const state = {
      enabled: true,
      acceptingUntil: null,
      pending: [
        {
          id: "waiting",
          code: "0042",
          clientName: "app",
          redirectHost: "app.test",
          requestedAt: 1,
          expiresAt: 2,
        },
      ],
    };
    const handlers = group.toLayer({
      [WS_METHODS.outsideAgentsSubscribe]: () =>
        Stream.fromEffect(
          Effect.sync(() => {
            calls++;
            return state;
          }),
        ),
      [WS_METHODS.outsideAgentsCommand]: () =>
        Effect.sync(() => {
          calls++;
          return state;
        }),
    });
    const scopes = [
      AuthAccessWriteScope,
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
      AuthSettingsWriteScope,
      AuthSourceControlWriteScope,
    ];
    for (const omitted of scopes) {
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            handlers,
            RpcAuthorization.layer(scopes.filter((scope) => scope !== omitted)),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.outsideAgentsSubscribe]({}).pipe(Stream.runCollect, Effect.flip),
      ).toMatchObject({ requiredPermission: omitted });
      expect(
        yield* client[WS_METHODS.outsideAgentsCommand]({
          _tag: "approve",
          id: "waiting",
          code: "0042",
          access: "read-only",
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: omitted });
    }
    expect(calls).toBe(0);
    const owner = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.mergeAll(handlers, RpcAuthorization.layer(scopes))),
    );
    expect(yield* owner[WS_METHODS.outsideAgentsSubscribe]({}).pipe(Stream.runCollect)).toEqual([
      state,
    ]);
    expect(yield* owner[WS_METHODS.outsideAgentsCommand]({ _tag: "deny", id: "waiting" })).toEqual(
      state,
    );
    expect(calls).toBe(2);
  }).pipe(Effect.scoped),
);
