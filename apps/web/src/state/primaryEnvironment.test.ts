import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createThemeEnvironmentIdAtom, primaryEnvironmentPending } from "./primaryEnvironment";

const PRIMARY = EnvironmentId.make("primary");
const SERVICE = EnvironmentId.make("service");
const REMOTE = EnvironmentId.make("remote");

function themeEnvironmentId(input: {
  primary: EnvironmentId | null;
  host: string | null;
  catalog: ReadonlyArray<EnvironmentId>;
}) {
  const atom = createThemeEnvironmentIdAtom({
    primaryEnvironmentIdAtom: Atom.make(input.primary),
    hostEnvironmentIdAtom: Atom.make(input.host),
    catalogValueAtom: Atom.make({ entries: new Map(input.catalog.map((id) => [id, null])) }),
  });
  return AtomRegistry.make().get(atom);
}

describe("themeEnvironmentIdAtom", () => {
  it("prefers the primary environment over this machine's background service", () => {
    expect(
      themeEnvironmentId({ primary: PRIMARY, host: "service", catalog: [PRIMARY, SERVICE] }),
    ).toBe(PRIMARY);
  });

  it("uses the connected background service sharing the app's SSHCode home when there is no primary", () => {
    expect(themeEnvironmentId({ primary: null, host: "service", catalog: [REMOTE, SERVICE] })).toBe(
      SERVICE,
    );
  });

  it("uses no environment when that service is not among the connections", () => {
    expect(themeEnvironmentId({ primary: null, host: "service", catalog: [REMOTE] })).toBeNull();
    expect(themeEnvironmentId({ primary: null, host: null, catalog: [REMOTE] })).toBeNull();
  });
});

it("is pending only where a machine of its own is expected and missing", () => {
  const desktop = { hostedStatic: false, localEnvironmentDisabled: false };
  expect(primaryEnvironmentPending({ primaryEnvironmentId: null, ...desktop })).toBe(true);
  expect(primaryEnvironmentPending({ primaryEnvironmentId: "mac", ...desktop })).toBe(false);
  // The hosted app and a desktop with its local machine off never get one.
  expect(
    primaryEnvironmentPending({ primaryEnvironmentId: null, ...desktop, hostedStatic: true }),
  ).toBe(false);
  expect(
    primaryEnvironmentPending({
      primaryEnvironmentId: null,
      ...desktop,
      localEnvironmentDisabled: true,
    }),
  ).toBe(false);
});
