import { assert, describe, expect, it } from "@effect/vitest";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import {
  headlessServeOutput,
  buildPairingUrl,
  formatHeadlessServeOutput,
  renderTerminalQrCode,
  resolveHeadlessConnectionHost,
  resolveHeadlessConnectionString,
  resolveListeningPort,
} from "./startupAccess.ts";

it("prefers localhost when no explicit host is configured", () => {
  expect(resolveHeadlessConnectionHost(undefined)).toBe("localhost");
  expect(resolveHeadlessConnectionString(undefined, 3773)).toBe("http://localhost:3773");
});

it("keeps explicit bind hosts in the connection string", () => {
  expect(resolveHeadlessConnectionString("127.0.0.1", 3773)).toBe("http://127.0.0.1:3773");
  expect(resolveHeadlessConnectionString("::1", 3773)).toBe("http://[::1]:3773");
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
      },
    ],
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
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("prefers the actual bound port when an http server address is available", () => {
  expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
  expect(resolveListeningPort("pipe", 3773)).toBe(3773);
  expect(resolveListeningPort(null, 3773)).toBe(3773);
});

it("builds a pairing URL that embeds the token in the hash", () => {
  expect(buildPairingUrl("http://192.168.1.42:3773", "PAIRCODE")).toBe(
    "http://192.168.1.42:3773/pair#token=PAIRCODE",
  );
});

it("renders terminal QR codes as a multi-line unicode block grid", () => {
  const qrCode = renderTerminalQrCode("http://192.168.1.42:3773/pair#token=PAIRCODE");

  assert.isTrue(qrCode.includes("█"));
  assert.isTrue(qrCode.split("\n").length > 10);
});

it("formats headless serve output with the connection string, token, pairing url, and qr code", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://192.168.1.42:3773",
    token: "PAIRCODE",
    pairingUrl: "http://192.168.1.42:3773/pair#token=PAIRCODE",
  });

  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("Token: PAIRCODE");
  expect(output).toContain("Pairing URL: http://192.168.1.42:3773/pair#token=PAIRCODE");
  assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
});

describe("headlessServeOutput", () => {
  const output = (serviceManaged: boolean) =>
    Effect.gen(function* () {
      let issued = 0;
      const text = yield* headlessServeOutput({ serviceManaged }).pipe(
        Effect.updateService(ServerConfig.ServerConfig, (config) => ({
          ...config,
          host: "127.0.0.1",
        })),
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              issueStartupPairingCredential: () =>
                Effect.sync(() => {
                  issued += 1;
                  return {
                    id: "startup",
                    credential: "FIXTURECODE1",
                    expiresAt: DateTime.makeUnsafe("2026-01-01T00:05:00Z"),
                  };
                }),
            }),
            Layer.mock(HttpServer.HttpServer)({
              address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
            }),
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-headless-output-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      );
      return { text, issued };
    });

  it.effect("prints pairing details for a server run in a terminal", () =>
    Effect.gen(function* () {
      const { text, issued } = yield* output(false);
      expect(issued).toBe(1);
      expect(text).toContain("Token: FIXTURECODE1");
      expect(text).toContain("#token=FIXTURECODE1");
    }),
  );

  it.effect("prints the address and the pair command for the background service", () =>
    Effect.gen(function* () {
      const { text, issued } = yield* output(true);
      expect(issued).toBe(0);
      expect(text).not.toContain("oken");
      expect(text).toBe(
        [
          "T3 Code server is ready.",
          "Connection string: http://127.0.0.1:3773",
          "Run `t3 pair` on this machine to connect a device.",
          "",
        ].join("\n"),
      );
    }),
  );
});
