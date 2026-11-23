import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import type { SecretRequestItem } from "@t3tools/client-runtime/secret-request";

const test = vi.hoisted(() => ({ answer: vi.fn(), allowed: true }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => test.allowed }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { answerSecretRequest: { permissionAtom: () => null } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => test.answer }));
vi.mock("../ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("./WorkLog", () => ({ WorkLogRow: () => null }));
import { SecretRequestCard } from "./SecretRequestCard";

const item = {
  id: TurnItemId.make("fake-request"),
  threadId: ThreadId.make("fake-thread"),
  type: "secret_request",
  secretStatus: "pending",
  label: "Fake service",
  reason: "Call the platform",
  apiKey: { name: "FAKE_API_KEY" },
} as SecretRequestItem;

it("keeps entry private, reveals on demand, sends selected scope/expiry only through the private RPC, then clears", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  test.answer.mockResolvedValue({ _tag: "Success" });
  test.allowed = true;
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <SecretRequestCard
          environmentId={EnvironmentId.make("fake-env")}
          item={item}
          visibility="local"
        />,
      );
    });
    const root = () => renderer!.root;
    const button = (text: string) =>
      root()
        .findAllByType("button")
        .find((element) => element.children.includes(text))!;
    const input = () =>
      root()
        .findAllByType("input")
        .find((element) => element.props.type !== "date")!;
    expect(input().props.type).toBe("password");
    await act(async () =>
      input().props.onChange({ currentTarget: { value: "obviously-fake-ui-key" } }),
    );
    await act(async () => button("Show").props.onClick());
    expect(input().props.type).toBe("text");
    await act(async () => button("All sessions").props.onClick());
    await act(async () => button("Never").props.onClick());
    await act(async () =>
      root()
        .findByType("form")
        .props.onSubmit({ preventDefault() {} }),
    );
    expect(test.answer).toHaveBeenLastCalledWith({
      environmentId: "fake-env",
      input: {
        threadId: "fake-thread",
        turnItemId: "fake-request",
        answer: { type: "save", secret: "obviously-fake-ui-key", scope: "all", expiresAt: null },
      },
    });
    expect(input().props.value).toBe("");
    expect(input().props.type).toBe("password");
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});

it("uses chat and 30 days by default and refuses to answer after permission is revoked", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  test.answer.mockClear();
  test.allowed = true;
  let renderer: ReactTestRenderer | undefined;
  const before = Date.now();
  try {
    await act(async () => {
      renderer = create(
        <SecretRequestCard
          environmentId={EnvironmentId.make("fake-env")}
          item={item}
          visibility="local"
        />,
      );
    });
    const input = renderer!.root.findAllByType("input")[0]!;
    await act(async () =>
      input.props.onChange({ currentTarget: { value: "obviously-fake-ui-key" } }),
    );
    await act(async () =>
      renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }),
    );
    expect(test.answer.mock.lastCall?.[0].input.answer).toMatchObject({
      scope: "chat",
      expiresAt: expect.any(Number),
    });
    expect(test.answer.mock.lastCall?.[0].input.answer.expiresAt).toBeGreaterThanOrEqual(
      before + 30 * 86_400_000,
    );
    test.allowed = false;
    await act(async () =>
      renderer!.update(
        <SecretRequestCard
          environmentId={EnvironmentId.make("fake-env")}
          item={item}
          visibility="local"
        />,
      ),
    );
    await act(async () =>
      renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }),
    );
    expect(test.answer).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
    test.allowed = true;
  }
});
