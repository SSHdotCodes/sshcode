import type { DesktopConnectionWakeupReason } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import * as DesktopNetworkInterfaces from "../../backend/DesktopNetworkInterfaces.ts";
import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import { installConnectionWakeups, networkInterfacesFingerprint } from "./connectionWakeups.ts";

describe("connectionWakeups", () => {
  it("ignores internal and link-local addresses and stays stable across key ordering", () => {
    const first = networkInterfacesFingerprint({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [
        { address: "169.254.1.2", family: "IPv4", internal: false },
        { address: "fe80::1", family: "IPv6", internal: false },
        { address: "192.168.1.42", family: "IPv4", internal: false },
      ],
      utun4: [{ address: "100.64.0.10", family: "IPv4", internal: false }],
    });
    const reordered = networkInterfacesFingerprint({
      utun4: [{ address: "100.64.0.10", family: "IPv4", internal: false }],
      en0: [{ address: "192.168.1.42", family: "IPv4", internal: false }],
    });

    assert.equal(first, reordered);
    assert.include(first, "en0:IPv4:192.168.1.42");
    assert.include(first, "utun4:IPv4:100.64.0.10");
    assert.notInclude(first, "127.0.0.1");
    assert.notInclude(first, "169.254.");
    assert.notInclude(first, "fe80:");
  });

  it.effect.each([false, true])(
    "forwards resume, unlock-screen, and interface changes (initial read fails: %s)",
    (initialReadFails) =>
      Effect.scoped(
        Effect.gen(function* () {
          const listeners = new Map<string, Set<() => void>>();
          let currentInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {
            en0: [{ address: "192.168.1.10", family: "IPv4", internal: false }],
          };
          const sent: DesktopConnectionWakeupReason[] = [];
          let reads = 0;

          const powerLayer = Layer.succeed(
            ElectronPowerMonitor.ElectronPowerMonitor,
            ElectronPowerMonitor.ElectronPowerMonitor.of({
              isOnBatteryPower: Effect.succeed(false),
              getSystemIdleTime: Effect.succeed(0),
              getSystemIdleState: () => Effect.succeed("active"),
              getCurrentThermalState: Effect.succeed("nominal"),
              onSimpleEvent: (eventName, listener) =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    const set = listeners.get(eventName) ?? new Set();
                    set.add(listener);
                    listeners.set(eventName, set);
                  }),
                  () =>
                    Effect.sync(() => {
                      listeners.get(eventName)?.delete(listener);
                    }),
                ).pipe(Effect.asVoid),
              onThermalStateChange: () => Effect.void,
              onSpeedLimitChange: () => Effect.void,
            }),
          );
          const networkLayer = Layer.succeed(
            DesktopNetworkInterfaces.DesktopNetworkInterfaces,
            DesktopNetworkInterfaces.DesktopNetworkInterfaces.of({
              read: Effect.sync(() => {
                if (reads++ === 0 && initialReadFails) throw new Error("interfaces unavailable");
                return currentInterfaces;
              }),
            }),
          );

          yield* installConnectionWakeups({
            broadcast: (reason) => {
              sent.push(reason);
            },
            pollInterval: Duration.seconds(5),
          }).pipe(Effect.provide(Layer.mergeAll(powerLayer, networkLayer)));

          // Resume with unchanged network emits only resume.
          for (const fn of listeners.get("resume") ?? []) fn();
          yield* Effect.yieldNow;
          assert.deepEqual(sent, ["resume"]);

          // Unlock with unchanged network emits only unlock-screen.
          for (const fn of listeners.get("unlock-screen") ?? []) fn();
          yield* Effect.yieldNow;
          assert.deepEqual(sent, ["resume", "unlock-screen"]);

          // Steady poll with unchanged network emits nothing.
          yield* TestClock.adjust(Duration.seconds(5));
          assert.deepEqual(sent, ["resume", "unlock-screen"]);

          // Network switch (e.g. new Wi-Fi IP or Tailscale interface) emits network-changed on poll.
          currentInterfaces = {
            en0: [{ address: "10.0.0.55", family: "IPv4", internal: false }],
            utun4: [{ address: "100.64.0.10", family: "IPv4", internal: false }],
          };
          yield* TestClock.adjust(Duration.seconds(5));
          assert.deepEqual(sent, ["resume", "unlock-screen", "network-changed"]);

          // Resume after network changed during sleep emits both resume and network-changed immediately.
          currentInterfaces = {
            en0: [{ address: "172.16.0.9", family: "IPv4", internal: false }],
          };
          for (const fn of listeners.get("resume") ?? []) fn();
          yield* Effect.yieldNow;
          assert.deepEqual(sent, [
            "resume",
            "unlock-screen",
            "network-changed",
            "resume",
            "network-changed",
          ]);
        }),
      ),
  );
});
