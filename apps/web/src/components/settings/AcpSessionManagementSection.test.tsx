import { isValidElement, type ReactElement } from "react";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  list: Symbol("list-acp-sessions"),
  import: Symbol("import-acp-session"),
  delete: Symbol("delete-acp-session"),
  listProviders: Symbol("list-acp-providers"),
  setProvider: Symbol("set-acp-provider"),
  disableProvider: Symbol("disable-acp-provider"),
  logout: Symbol("logout-acp"),
}));

const commands = vi.hoisted(() => ({
  list: vi.fn(),
  import: vi.fn(),
  delete: vi.fn(),
  listProviders: vi.fn(),
  setProvider: vi.fn(),
  disableProvider: vi.fn(),
  logout: vi.fn(),
}));

const grants = vi.hoisted(() => ({ scopes: new Set<string>() }));
vi.mock("~/state/session", async (original) => ({
  ...(await original<typeof import("~/state/session")>()),
  useEnvironmentScope: (_id: unknown, scope: string) => grants.scopes.has(scope),
  readEnvironmentScope: (_id: unknown, scope: string) => grants.scopes.has(scope),
}));
const dialogs = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useLayoutEffect: () => {},
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    listAcpRegistrySessions: atoms.list,
    importAcpRegistrySession: atoms.import,
    deleteAcpRegistrySession: atoms.delete,
    listAcpRegistryProviders: atoms.listProviders,
    setAcpRegistryProvider: atoms.setProvider,
    disableAcpRegistryProvider: atoms.disableProvider,
    logoutAcpRegistry: atoms.logout,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => {
    if (atom === atoms.list) return commands.list;
    if (atom === atoms.import) return commands.import;
    if (atom === atoms.delete) return commands.delete;
    if (atom === atoms.listProviders) return commands.listProviders;
    if (atom === atoms.setProvider) return commands.setProvider;
    if (atom === atoms.disableProvider) return commands.disableProvider;
    return commands.logout;
  },
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs }),
}));

import { AcpSessionManagementSection } from "./AcpSessionManagementSection";

const environmentId = EnvironmentId.make("remote-device");
const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
const projectId = ProjectId.make("project-antigravity");
const session = {
  sessionId: "native-session-1",
  cwd: "/workspace/antigravity",
  additionalDirectories: [],
  title: "Native Antigravity session",
  updatedAt: "2026-08-23T00:00:00Z",
  importedThreadId: null,
} as const;
const provider = {
  instanceId,
  driver: ProviderDriverKind.make("acpRegistry"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", canLogout: true },
  nativeSessions: { canList: true, canLoad: true, canResume: true, canDelete: true },
  configurableProviders: true,
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

function render(
  readOnly = false,
  projects: ReadonlyArray<{ id: ProjectId; title: string; workspaceRoot: string }> = [
    { id: projectId, title: "Antigravity", workspaceRoot: session.cwd },
  ],
): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  const tree = AcpSessionManagementSection({
    environmentId,
    instanceId,
    provider,
    projects,
    readOnly,
  }) as ReactElement<Record<string, unknown>>;
  if (
    isValidElement(tree) &&
    typeof tree.type === "function" &&
    tree.type.name === "InstanceSessionManagement"
  ) {
    return (tree.type as (props: typeof tree.props) => ReactElement<Record<string, unknown>>)(
      tree.props,
    );
  }
  return tree;
}

function findByLabel(
  tree: ReactElement<Record<string, unknown>>,
  label: string,
): ReactElement<Record<string, unknown>> {
  const found = visitElements(tree, (element) => element.props.children === label);
  expect(found).not.toBeNull();
  return found!;
}

function findByAriaLabel(
  tree: ReactElement<Record<string, unknown>>,
  label: string,
): ReactElement<Record<string, unknown>> {
  const found = visitElements(tree, (element) => element.props["aria-label"] === label);
  expect(found).not.toBeNull();
  return found!;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  hooks.reset();
  grants.scopes = new Set(["orchestration:read", "orchestration:operate", "providers:manage"]);
  commands.list.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      sessions: [session],
      nextCursor: null,
      canLoad: true,
      canResume: true,
      canDelete: true,
    },
  });
  commands.import.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { threadId: ThreadId.make("thread-imported"), imported: true },
  });
  commands.delete.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { deleted: true },
  });
  commands.listProviders.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      providers: [
        {
          providerId: "google",
          supported: ["openai"],
          required: false,
          current: { apiType: "openai", baseUrl: "https://api.example.test/v1" },
        },
      ],
    },
  });
  commands.setProvider.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { configured: true },
  });
  commands.disableProvider.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { disabled: true },
  });
  commands.logout.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { loggedOut: true },
  });
  dialogs.confirm.mockReset().mockResolvedValue(true);
});

describe("AcpSessionManagementSection", () => {
  it("lists and imports native sessions through the owning environment", async () => {
    const initial = render();
    (findByLabel(initial, "List sessions").props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.list).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, projectId },
    });

    const listed = render();
    (findByLabel(listed, "Import").props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.import).toHaveBeenCalledWith({
      environmentId,
      input: {
        instanceId,
        projectId,
        sessionId: session.sessionId,
        title: session.title,
        updatedAt: session.updatedAt,
      },
    });
    expect(findByLabel(render(), "Imported")).not.toBeNull();
  });

  it("logs out the provider instance through the owning environment", async () => {
    const tree = render();
    (findByLabel(tree, "Log out").props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.logout).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId },
    });
  });

  it("deletes unimported native sessions after destructive confirmation", async () => {
    (findByLabel(render(), "List sessions").props.onClick as (() => void) | undefined)?.();
    await flushPromises();
    (findByLabel(render(), "Delete").props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(dialogs.confirm).toHaveBeenCalledOnce();
    expect(commands.delete).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, projectId, sessionId: session.sessionId },
    });
  });

  it("locks the project picker while a project-scoped request is pending", async () => {
    let resolveProviders!: (result: {
      readonly _tag: "Success";
      readonly value: { readonly providers: [] };
    }) => void;
    commands.listProviders.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProviders = resolve;
      }),
    );
    (findByLabel(render(), "List providers").props.onClick as (() => void) | undefined)?.();

    const projectSelect = visitElements(
      render(),
      (element) =>
        element.props.value === projectId && typeof element.props.onValueChange === "function",
    );
    expect(projectSelect?.props.disabled).toBe(true);
    resolveProviders({ _tag: "Success", value: { providers: [] } });
    await flushPromises();
  });

  it("lists, saves, and disables configurable ACP providers", async () => {
    (findByLabel(render(), "List providers").props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.listProviders).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, projectId },
    });
    const providers = render();
    expect(findByAriaLabel(providers, "google protocol").props.size).toBe("sm");
    (findByLabel(providers, "Save").props.onClick as (() => void) | undefined)?.();
    await flushPromises();
    expect(commands.setProvider).toHaveBeenCalledWith({
      environmentId,
      input: {
        instanceId,
        projectId,
        providerId: "google",
        apiType: "openai",
        baseUrl: "https://api.example.test/v1",
      },
    });

    (findByLabel(render(), "Disable").props.onClick as (() => void) | undefined)?.();
    await flushPromises();
    expect(commands.disableProvider).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, projectId, providerId: "google" },
    });
  });

  it.each(["Save", "Disable"] as const)(
    "keeps other provider edits through a %s refetch",
    async (action) => {
      const providers = ["google", "other"].map((providerId) => ({
        providerId,
        supported: ["openai"],
        required: false,
        current: { apiType: "openai", baseUrl: "https://api.example.test/v1" },
      }));
      commands.listProviders.mockResolvedValue({ _tag: "Success", value: { providers } });
      (findByLabel(render(), "List providers").props.onClick as () => void)();
      await flushPromises();

      const listed = render();
      (findByAriaLabel(listed, "other base URL").props.onValueChange as (value: string) => void)(
        "https://other.example.test/v1",
      );
      const withUrl = render();
      (
        findByAriaLabel(withUrl, "other write-only headers JSON").props.onValueChange as (
          value: string,
        ) => void
      )('{"X-Test":"unsaved"}');

      (findByLabel(render(), action).props.onClick as () => void)();
      for (let step = 0; step < 6; step += 1) await flushPromises();

      const kept = render();
      expect(findByAriaLabel(kept, "other base URL").props.value).toBe(
        "https://other.example.test/v1",
      );
      expect(findByAriaLabel(kept, "other write-only headers JSON").props.value).toBe(
        '{"X-Test":"unsaved"}',
      );
      expect(findByAriaLabel(kept, "google write-only headers JSON").props.value).toBe("");

      (findByLabel(kept, "Refresh").props.onClick as () => void)();
      await flushPromises();
      const refreshed = render();
      expect(findByAriaLabel(refreshed, "other base URL").props.value).toBe(
        "https://api.example.test/v1",
      );
      expect(findByAriaLabel(refreshed, "other write-only headers JSON").props.value).toBe("");
    },
  );

  it("drops a session list that finishes after the project changes", async () => {
    const otherProjectId = ProjectId.make("project-other");
    let resolveList!: (result: {
      readonly _tag: "Success";
      readonly value: {
        readonly sessions: readonly [typeof session];
        readonly nextCursor: null;
        readonly canLoad: true;
        readonly canResume: true;
        readonly canDelete: true;
      };
    }) => void;
    commands.list.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const projects = [
      { id: projectId, title: "Antigravity", workspaceRoot: session.cwd },
      { id: otherProjectId, title: "Other", workspaceRoot: "/workspace/other" },
    ];
    (findByLabel(render(false, projects), "List sessions").props.onClick as () => void)();
    const projectSelect = visitElements(
      render(false, projects),
      (element) =>
        element.props["aria-label"] === undefined &&
        element.props.value === projectId &&
        typeof element.props.onValueChange === "function",
    );
    expect(projectSelect).not.toBeNull();
    (projectSelect!.props.onValueChange as (value: string) => void)(otherProjectId);
    render(false, projects);
    resolveList({
      _tag: "Success",
      value: {
        sessions: [session],
        nextCursor: null,
        canLoad: true,
        canResume: true,
        canDelete: true,
      },
    });
    for (let step = 0; step < 4; step += 1) await flushPromises();

    const after = render(false, projects);
    expect(visitElements(after, (element) => element.props.children === session.title)).toBeNull();
  });
});

it("imports with task access even when provider configuration is read-only", async () => {
  grants.scopes.delete("providers:manage");
  (findByLabel(render(true), "List sessions").props.onClick as () => void)();
  await flushPromises();
  (findByLabel(render(true), "Import").props.onClick as () => void)();
  await flushPromises();
  expect(commands.import).toHaveBeenCalledOnce();
});

it("does not import with provider management alone", async () => {
  grants.scopes.delete("orchestration:operate");
  (findByLabel(render(), "List sessions").props.onClick as () => void)();
  await flushPromises();
  (findByLabel(render(), "Import").props.onClick as () => void)();
  await flushPromises();
  expect(commands.import).not.toHaveBeenCalled();
});

it("rechecks task access after confirming deletion", async () => {
  (findByLabel(render(), "List sessions").props.onClick as () => void)();
  await flushPromises();
  dialogs.confirm.mockImplementationOnce(async () => {
    grants.scopes.delete("orchestration:operate");
    return true;
  });
  (findByLabel(render(), "Delete").props.onClick as () => void)();
  await flushPromises();
  expect(commands.delete).not.toHaveBeenCalled();
});
