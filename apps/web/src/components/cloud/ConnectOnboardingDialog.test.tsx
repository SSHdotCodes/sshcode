import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import { act, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  isSignedIn: false,
  userId: null as string | null,
  linkStateData: null as EnvironmentCloudLinkStateResult | null,
  reconcile: vi.fn<(input: { managedTunnel: boolean; publish: boolean }) => Promise<boolean>>(),
  cancelReconciliation: vi.fn(),
  dialogOpen: false,
  dialogOnOpenChange: null as ((open: boolean) => void) | null,
  toast: vi.fn(),
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: testState.isSignedIn,
    userId: testState.userId,
  }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ _tag: "Success" }) }));
vi.mock("~/cloud/publicConfig", () => ({ hasCloudPublicConfig: () => true }));
vi.mock("~/cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => ({
    linkState: {
      target: { environmentId: "primary" },
      data: testState.linkStateData,
      error: null,
    },
    operationError: null,
    reconcileCloudState: testState.reconcile,
    cancelReconciliation: testState.cancelReconciliation,
  }),
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  useLocalStorage: () => [{ optOutAccounts: [] }, vi.fn()],
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ isReady: true, environments: [] }),
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => "primary",
}));
vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => ({}) },
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: testState.toast } }));
vi.mock("./CloudEnvironmentConnectList", () => ({ CloudEnvironmentConnectRows: () => null }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) => {
    testState.dialogOpen = open;
    testState.dialogOnOpenChange = onOpenChange;
    return open ? children : null;
  },
}));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentPropsWithoutRef<"button">) => <button {...props} />,
}));
vi.mock("../ui/checkbox", () => ({ Checkbox: () => null }));
vi.mock("../ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    "aria-label": string;
  }) => (
    <button
      role="switch"
      aria-checked={checked}
      {...props}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));
vi.mock("../ui/wizard", () => ({
  WizardSteps: () => null,
  WizardPopup: ({ children }: { children: ReactNode }) => children,
  WizardHeader: ({ children }: { children: ReactNode }) => children,
  WizardPanel: ({ children }: { children: ReactNode }) => children,
  WizardFooter: ({ children }: { children: ReactNode }) => children,
}));

import { ConnectOnboardingDialog } from "./ConnectOnboardingDialog";

function linkedState(
  cloudUserId: string,
  managedTunnelActive: boolean,
  publishAgentActivity: boolean,
): EnvironmentCloudLinkStateResult {
  return {
    linked: true,
    cloudUserId,
    relayUrl: "https://relay.example.com",
    relayIssuer: "https://relay.example.com",
    managedTunnelActive,
    publishAgentActivity,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let renderer: ReactTestRenderer | null = null;

async function renderDialog() {
  await act(() => {
    renderer = create(<ConnectOnboardingDialog />);
  });
}

async function updateDialog() {
  await act(() => renderer?.update(<ConnectOnboardingDialog />));
}

async function signIn(account: string) {
  testState.isSignedIn = true;
  testState.userId = account;
  await updateDialog();
}

function continueButton() {
  return renderer!.root.find(
    (node) =>
      node.type === "button" &&
      (node.props.children === "Continue" || node.props.children === "Enabling…"),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.isSignedIn = false;
  testState.userId = null;
  testState.linkStateData = null;
  testState.reconcile.mockReset().mockResolvedValue(true);
  testState.cancelReconciliation.mockReset();
  testState.dialogOpen = false;
  testState.dialogOnOpenChange = null;
  testState.toast.mockReset();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("ConnectOnboardingDialog", () => {
  it("prefills only from the account being onboarded", async () => {
    testState.linkStateData = linkedState("account-a", true, true);
    await renderDialog();
    await signIn("account-b");

    testState.linkStateData = linkedState("account-b", false, false);
    await updateDialog();

    const toggles = renderer!.root.findAll(
      (node) => node.type === "button" && node.props.role === "switch",
    );
    expect(toggles.map((toggle) => toggle.props["aria-checked"])).toEqual([false, false]);
  });

  it("ignores a publish completion from an account switch's older operation", async () => {
    testState.linkStateData = linkedState("account-a", true, true);
    const pending = deferred<boolean>();
    testState.reconcile.mockReturnValue(pending.promise);
    await renderDialog();
    await signIn("account-a");
    await act(() => continueButton().props.onClick());

    testState.linkStateData = linkedState("account-b", true, true);
    await signIn("account-b");
    pending.resolve(true);
    await act(async () => {
      await pending.promise;
    });

    expect(continueButton().props.disabled).toBe(false);
    expect(testState.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "T3 Connect enabled" }),
    );
  });

  it("cancels a pending publish instead of blocking dismissal", async () => {
    testState.linkStateData = linkedState("account-a", true, true);
    testState.reconcile.mockReturnValue(deferred<boolean>().promise);
    await renderDialog();
    await signIn("account-a");
    await act(() => continueButton().props.onClick());
    expect(testState.dialogOpen).toBe(true);

    await act(() => testState.dialogOnOpenChange?.(false));

    expect(testState.cancelReconciliation).toHaveBeenCalledOnce();
    expect(testState.dialogOpen).toBe(false);
  });

  it("clears publishing state and reports an unexpected rejection", async () => {
    testState.linkStateData = linkedState("account-a", true, true);
    testState.reconcile.mockRejectedValue(new Error("Connection failed."));
    await renderDialog();
    await signIn("account-a");
    await act(async () => {
      continueButton().props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(continueButton().props.disabled).toBe(false);
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Could not enable T3 Connect" }),
    );
  });
});
