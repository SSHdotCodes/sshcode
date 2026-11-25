import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import type * as NodeOS from "node:os";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "./DirectEndpoints.ts";
import { resolveBoundEndpoints } from "./DirectEndpoints.ts";

const INTERFACES: ReturnType<typeof NodeOS.networkInterfaces> = {
  lo0: [
    {
      address: "127.0.0.1",
      netmask: "255.0.0.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: true,
      cidr: "127.0.0.1/8",
    },
  ],
  en0: [
    {
      address: "192.168.1.10",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "aa:bb:cc:dd:ee:ff",
      internal: false,
      cidr: "192.168.1.10/24",
    },
    {
      address: "fe80::1",
      netmask: "ffff:ffff:ffff:ffff::",
      family: "IPv6",
      mac: "aa:bb:cc:dd:ee:ff",
      internal: false,
      cidr: "fe80::1/64",
      scopeid: 4,
    },
  ],
  en1: [
    {
      address: "203.0.113.20",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "aa:bb:cc:dd:ee:00",
      internal: false,
      cidr: "203.0.113.20/24",
    },
  ],
  // Tailscale on macOS: an anonymous utun that also carries a Tailscale IPv6 address.
  utun4: [
    {
      address: "100.101.102.103",
      netmask: "255.255.255.255",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: "100.101.102.103/32",
    },
    {
      address: "fd7a:115c:a1e0::1",
      netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      family: "IPv6",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: "fd7a:115c:a1e0::1/128",
      scopeid: 0,
    },
  ],
};

/** A VPN interface with an address from the same 100.64.0.0/10 range. */
const vpnInterface = (address: string) => [
  {
    address,
    netmask: "255.255.255.255",
    family: "IPv4" as const,
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/32`,
  },
];

const virtualInterface = (address: string) => [
  {
    address,
    netmask: "255.255.0.0",
    family: "IPv4" as const,
    mac: "02:42:ac:11:00:01",
    internal: false,
    cidr: `${address}/16`,
  },
];

describe("resolveBoundEndpoints", () => {
  it("lists nothing for a loopback-only server", () => {
    expect(resolveBoundEndpoints({ host: undefined, port: 3773, interfaces: INTERFACES })).toEqual(
      [],
    );
    expect(
      resolveBoundEndpoints({ host: "127.0.0.1", port: 3773, interfaces: INTERFACES }),
    ).toEqual([]);
  });

  it("lists every external IPv4 address for a wildcard bind, tagging the tailnet one", () => {
    expect(resolveBoundEndpoints({ host: "0.0.0.0", port: 3773, interfaces: INTERFACES })).toEqual([
      { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" },
      { kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" },
    ]);
  });

  it("skips container and VM networks, which only this machine reaches", () => {
    const interfaces = {
      ...INTERFACES,
      docker0: virtualInterface("172.17.0.1"),
      "br-3f2a1b": virtualInterface("172.18.0.1"),
      virbr0: virtualInterface("192.168.122.1"),
      "vEthernet (WSL)": virtualInterface("172.24.0.1"),
      bridge100: virtualInterface("192.168.64.1"),
      vmbr0: virtualInterface("192.168.1.20"),
    };
    expect(resolveBoundEndpoints({ host: "0.0.0.0", port: 3773, interfaces })).toEqual([
      { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" },
      { kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" },
      { kind: "lan", httpBaseUrl: "http://192.168.1.20:3773/" },
    ]);
  });

  it("tags only addresses on Tailscale's interface as tailnet, not other VPNs in its range", () => {
    const interfaces = {
      en0: INTERFACES.en0,
      tailscale0: vpnInterface("100.70.1.2"),
      CloudflareWARP: vpnInterface("100.96.0.1"),
      utun7: vpnInterface("100.85.0.1"),
    };
    expect(resolveBoundEndpoints({ host: "0.0.0.0", port: 3773, interfaces })).toEqual([
      { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" },
      { kind: "tailnet", httpBaseUrl: "http://100.70.1.2:3773/" },
      { kind: "lan", httpBaseUrl: "http://100.96.0.1:3773/" },
      { kind: "lan", httpBaseUrl: "http://100.85.0.1:3773/" },
    ]);
  });

  it("lists only the bound address for a specific bind", () => {
    expect(
      resolveBoundEndpoints({ host: "100.101.102.103", port: 3773, interfaces: INTERFACES }),
    ).toEqual([{ kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" }]);
  });

  it("never reports a host name, which can resolve to another machine per client", () => {
    for (const host of ["server.local", "devbox", "devbox.home.arpa"]) {
      expect(resolveBoundEndpoints({ host, port: 3773, interfaces: INTERFACES })).toEqual([]);
    }
  });

  it("never reports a public address, which would carry the credential over plain HTTP", () => {
    expect(
      resolveBoundEndpoints({ host: "203.0.113.20", port: 3773, interfaces: INTERFACES }),
    ).toEqual([]);
  });
});

const TAILSCALE_STATUS_JSON = JSON.stringify({
  Self: { DNSName: "bb-1.tail1234.ts.net.", TailscaleIPs: ["100.64.1.2"] },
});

/** `tailscale status --json` reporting a MagicDNS name. */
const layerTailscaleUpCounting = (onSpawn: () => void) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.sync(onSpawn).pipe(
        Effect.as(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(TAILSCALE_STATUS_JSON)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      ),
    ),
  );
const layerTailscaleUp = layerTailscaleUpCounting(() => {});

/** Answers the Serve probe with `status`. */
const layerServeProbe = (status: number) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status }))),
    ),
  );

/** A loopback-only server with Tailscale Serve on, so only the Serve name can be listed. */
const layerServeConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.map(ServerConfig.ServerConfig, (config) => ({
    ...config,
    host: "127.0.0.1",
    tailscaleServeEnabled: true,
    tailscaleServePort: 443,
  })),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-direct-" })),
  Layer.provide(NodeServices.layer),
);

const resolveWithServe = (probeStatus: number) =>
  Effect.flatMap(DirectEndpoints.DirectEndpoints, (service) => service.resolve()).pipe(
    Effect.provide(
      DirectEndpoints.layer.pipe(
        Layer.provide(
          Layer.mergeAll(layerServeConfig, layerTailscaleUp, layerServeProbe(probeStatus)),
        ),
      ),
    ),
  );

/** Each resolve reports the spawns so far; the probe answers `status()`. */
const withCountingServe = <A, E>(
  status: () => number,
  use: (resolve: Effect.Effect<number>) => Effect.Effect<A, E, DirectEndpoints.DirectEndpoints>,
) => {
  let spawns = 0;
  return Effect.flatMap(DirectEndpoints.DirectEndpoints, (service) =>
    use(service.resolve().pipe(Effect.map(() => spawns))),
  ).pipe(
    Effect.provide(
      DirectEndpoints.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerServeConfig,
            layerTailscaleUpCounting(() => spawns++),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() =>
                  HttpClientResponse.fromWeb(request, new Response(null, { status: status() })),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
};

describe("DirectEndpoints Tailscale Serve", () => {
  effectIt.effect("lists the tailnet name once Serve answers for this server", () =>
    Effect.gen(function* () {
      expect(yield* resolveWithServe(200)).toEqual([
        { kind: "tailnet", httpBaseUrl: "https://bb-1.tail1234.ts.net/" },
      ]);
    }),
  );

  effectIt.effect("leaves the tailnet name out when Serve is not forwarding", () =>
    Effect.gen(function* () {
      expect(yield* resolveWithServe(502)).toEqual([]);
    }),
  );

  effectIt.effect("connects within a minute share one Serve lookup", () =>
    withCountingServe(
      () => 200,
      (resolve) =>
        Effect.gen(function* () {
          expect(yield* resolve).toBe(1);
          expect(yield* resolve).toBe(1);
          yield* TestClock.adjust("61 seconds");
          expect(yield* resolve).toBe(2);
        }),
    ),
  );

  effectIt.effect("looks for a missing Serve name again after a few seconds", () => {
    let status = 502;
    return withCountingServe(
      () => status,
      (resolve) =>
        Effect.gen(function* () {
          expect(yield* resolve).toBe(1);
          status = 200;
          expect(yield* resolve).toBe(1);
          yield* TestClock.adjust("6 seconds");
          expect(yield* resolve).toBe(2);
        }),
    );
  });

  effectIt.effect("retries immediately after a Serve refresh dies", () => {
    let probes = 0;
    return withCountingServe(
      () => {
        probes++;
        if (probes === 2) throw new Error("Serve probe defect");
        return probes === 1 ? 200 : 502;
      },
      (resolve) =>
        Effect.gen(function* () {
          expect(yield* resolve).toBe(1);
          yield* TestClock.adjust("61 seconds");
          expect(yield* resolve).toBe(2);
          yield* TestClock.adjust("1 millis");
          expect(yield* resolve).toBe(3);
        }),
    );
  });

  effectIt.effect(
    "returns the cached Serve endpoint immediately while refreshing after TTL",
    () => {
      const releaseRefresh = Deferred.makeUnsafe<void>();
      let phase = 1;
      let refreshStarted = false;
      let status = 200;
      const layer = DirectEndpoints.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerServeConfig,
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.gen(function* () {
                  if (phase === 2) {
                    refreshStarted = true;
                    yield* Deferred.await(releaseRefresh);
                  }
                  return ChildProcessSpawner.makeHandle({
                    pid: ChildProcessSpawner.ProcessId(1),
                    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                    isRunning: Effect.succeed(false),
                    kill: () => Effect.void,
                    unref: Effect.succeed(Effect.void),
                    stdin: Sink.drain,
                    stdout: Stream.make(new TextEncoder().encode(TAILSCALE_STATUS_JSON)),
                    stderr: Stream.empty,
                    all: Stream.empty,
                    getInputFd: () => Sink.drain,
                    getOutputFd: () => Stream.empty,
                  });
                }),
              ),
            ),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() =>
                  HttpClientResponse.fromWeb(request, new Response(null, { status })),
                ),
              ),
            ),
          ),
        ),
      );

      return Effect.gen(function* () {
        const service = yield* DirectEndpoints.DirectEndpoints;
        const first = yield* service.resolve();
        expect(first).toEqual([{ kind: "tailnet", httpBaseUrl: "https://bb-1.tail1234.ts.net/" }]);

        phase = 2;
        status = 502;
        yield* TestClock.adjust("61 seconds");

        // Must return cached endpoint immediately without waiting on releaseRefresh.
        const stale = yield* service.resolve();
        expect(stale).toEqual(first);
        expect(refreshStarted).toBe(true);

        yield* Deferred.succeed(releaseRefresh, undefined);
        yield* Effect.yieldNow;
        expect(yield* service.resolve()).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );
});
