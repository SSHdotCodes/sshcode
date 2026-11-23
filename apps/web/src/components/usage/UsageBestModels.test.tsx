import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ pending: true }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "presentations"
      ? new Map([
          [
            "env",
            {
              serverConfig: {
                providers: [
                  {
                    instanceId: "codex",
                    driver: "codex",
                    displayName: "Pro",
                    enabled: true,
                    installed: true,
                    status: "ready",
                    auth: { status: "authenticated", label: "ChatGPT Pro 20x Subscription" },
                    models: [],
                  },
                ],
              },
            },
          ],
        ])
      : [],
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: "presentations" },
}));
vi.mock("../../state/server", () => ({
  subagentRankingsEnvironment: { snapshotAtom: () => "rankings" },
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (s: unknown) => unknown) =>
    select({ usagePlanPrices: {}, defaultModelSelection: null }),
  useUpdatePrimarySettings: () => vi.fn(),
}));
vi.mock("./useBenchmarkTable", () => ({
  useBenchmarkTable: () => ({ asOf: "2026-11-17", metrics: {}, models: [] }),
}));
vi.mock("./UsageDither", () => ({ UsageDither: () => null }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../ui/popover", () => ({ Popover: "div", PopoverPopup: "div", PopoverTrigger: "div" }));
vi.mock("../../state/usage", () => ({
  useUsage: () => ({
    shown: {},
    selectedEnvironments: [
      {
        environmentId: "env",
        label: "Env",
        isConnected: true,
        isPending: state.pending,
        error: null,
        summary: {
          contractVersion: 6,
          readAt: "2026-11-17T16:00:00Z",
          timeZone: "America/New_York",
          sinceDay: "2026-10-19",
          untilDay: "2026-11-17",
          buckets: [
            {
              day: "2026-11-17",
              provider: "codex",
              model: "test-model",
              sourcePath: "/shared",
              totals: {
                uncachedInputTokens: 1000000,
                cachedInputTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 1000000,
                reasoningTokens: 0,
              },
              costUsd: 0.32,
              cacheSavingsUsd: 0,
              costSource: "modelPriced",
              records: 1,
              unpricedRecords: 0,
              sessions: 1,
            },
          ],
          sources: [
            {
              instanceId: "codex",
              fingerprint: {
                hostId: "host",
                provider: "codex",
                resolvedHomePath: "/shared",
                volumeId: "vol",
              },
              status: "ok",
              scannedFiles: 1,
              skippedFiles: 0,
              malformedRecords: 0,
              distinctSessions: 1,
              message: null,
              ...(state.pending ? { refreshing: true } : {}),
            },
          ],
          pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
          scanDurationMs: 1,
        },
      },
    ],
  }),
}));

import { UsageBestModels } from "./UsageBestModels";
let renderer: ReactTestRenderer | undefined;
function renderedText(node: ReturnType<ReactTestRenderer["toJSON"]>): string {
  if (node === null) return "";
  if (Array.isArray(node)) return node.map(renderedText).join("");
  return (node.children ?? [])
    .map((child) => (typeof child === "string" ? child : renderedText(child)))
    .join("");
}

afterEach(async () => {
  await act(() => renderer?.unmount());
});

it("withholds partial plan totals and model prices until its own evidence window finishes", async () => {
  const element = () => (
    <UsageBestModels
      selectedEnvironmentIds={null}
      hiddenProviders={new Set()}
      now={Date.parse("2026-11-17T16:00:00Z")}
    />
  );
  state.pending = true;
  await act(() => {
    renderer = create(element());
  });
  expect(renderedText(renderer!.toJSON())).not.toContain("of work at API prices");
  expect(renderedText(renderer!.toJSON())).not.toContain("$");
  expect(renderedText(renderer!.toJSON())).toContain("Updating usage");
  state.pending = false;
  await act(() => {
    renderer!.update(element());
  });
  expect(renderedText(renderer!.toJSON())).toContain("of work at API prices");
  expect(renderedText(renderer!.toJSON())).not.toContain("Updating usage");
});
