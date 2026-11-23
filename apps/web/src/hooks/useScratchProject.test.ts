import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { landingReady, resolveScratchEnvironment } from "./useScratchProject";

const mac = EnvironmentId.make("mac");
const nova = EnvironmentId.make("nova");
const ready = { scratchWorkspaceRoot: "/scratch" };

describe("resolveScratchEnvironment", () => {
  it("keeps a new chat on the current machine while it is still starting", () => {
    const entries = [
      { environmentId: mac, phase: "connecting" as const, serverConfig: null },
      { environmentId: nova, phase: "connected" as const, serverConfig: ready },
    ];
    expect(resolveScratchEnvironment(entries, mac)).toBe(mac);
    expect(
      resolveScratchEnvironment(
        [{ environmentId: mac, phase: "connected", serverConfig: null }, entries[1]!],
        mac,
      ),
    ).toBe(mac);
    // With no current machine, a starting one means Nova isn't the only choice.
    expect(resolveScratchEnvironment(entries, null)).toBeNull();
  });

  it("drops machines that are offline or offer no scratch folder", () => {
    expect(
      resolveScratchEnvironment(
        [{ environmentId: mac, phase: "offline", serverConfig: ready }],
        mac,
      ),
    ).toBeNull();
    expect(
      resolveScratchEnvironment(
        [{ environmentId: mac, phase: "connected", serverConfig: {} }],
        mac,
      ),
    ).toBeNull();
    expect(
      resolveScratchEnvironment(
        [
          { environmentId: mac, phase: "offline", serverConfig: null },
          { environmentId: nova, phase: "connected", serverConfig: ready },
        ],
        null,
      ),
    ).toBe(nova);
  });

  it("picks no other machine while this client's own one has not registered yet", () => {
    // After a restart the saved Nova loads from storage before the Mac appears at all.
    const onlyNova = [{ environmentId: nova, phase: "connected" as const, serverConfig: ready }];
    expect(resolveScratchEnvironment(onlyNova, null, true)).toBeNull();
    // The hosted app never has a machine of its own, so the one that offers it still wins.
    expect(resolveScratchEnvironment(onlyNova, null, false)).toBe(nova);
    // A machine the user is already on is unaffected.
    expect(resolveScratchEnvironment(onlyNova, nova, true)).toBe(nova);
  });
});

describe("landingReady", () => {
  it("opens the first chat once its own machine has loaded, without the others", () => {
    // Nova is offline or still loading: this Mac's chat list is enough.
    expect(
      landingReady({ scratchEnvironmentId: mac, scratchShellLoaded: true, allShellsLoaded: false }),
    ).toBe(true);
    expect(
      landingReady({
        scratchEnvironmentId: mac,
        scratchShellLoaded: false,
        allShellsLoaded: false,
      }),
    ).toBe(false);
  });

  it("waits for every machine when the chat has to start in a project", () => {
    expect(
      landingReady({
        scratchEnvironmentId: null,
        scratchShellLoaded: false,
        allShellsLoaded: false,
      }),
    ).toBe(false);
    expect(
      landingReady({
        scratchEnvironmentId: null,
        scratchShellLoaded: false,
        allShellsLoaded: true,
      }),
    ).toBe(true);
  });
});
