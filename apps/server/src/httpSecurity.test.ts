import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { layerTransportSecurity, sessionCookieOptions } from "./httpSecurity.ts";

const cases = [
  { origin: "http://127.0.0.1:3774", secure: false, hsts: false },
  { origin: "http://localhost:3774", secure: false, hsts: false },
  { origin: "http://[::1]:3774", secure: false, hsts: false },
  { origin: "http://sshcode-studio.localhost:3774", secure: false, hsts: false },
  { origin: "http://localhost.example", secure: true, hsts: true },
  ...[
    "cf-connecting-ip",
    "cf-ray",
    "x-forwarded-for",
    "x-real-ip",
    "forwarded",
    "x-forwarded-proto",
  ].map((header) => ({
    origin: "http://localhost:3774",
    headers: { [header]: "fake-relay" },
    secure: true,
    hsts: false,
  })),
  { origin: "https://localhost:3774", secure: true, hsts: false },
  { origin: "https://remote.example", secure: true, hsts: true },
  { origin: "http://remote.example", secure: true, hsts: true },
  { origin: "http://192.168.1.10", secure: true, hsts: true },
  {
    origin: "http://remote.example",
    headers: { "x-forwarded-proto": "https" },
    secure: true,
    hsts: true,
  },
  {
    origin: "http://localhost:3774",
    headers: { "x-forwarded-host": "remote.example" },
    secure: true,
    hsts: false,
  },
];

it.each(cases)("serializes transport protection for $origin $headers", async (testCase) => {
  const route = HttpRouter.add(
    "GET",
    "/cookie",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return HttpServerResponse.setCookieUnsafe(
        HttpServerResponse.empty(),
        "test_session",
        "synthetic-test-token",
        sessionCookieOptions(request),
      );
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    route.pipe(Layer.provide(layerTransportSecurity)),
    { disableLogger: true },
  );
  try {
    const response = await handler(
      new Request(`${testCase.origin}/cookie`, {
        headers: {
          host: new URL(testCase.origin).host,
          ...(testCase.origin.startsWith("https:") ? { "x-forwarded-proto": "https" } : {}),
          ...("headers" in testCase ? testCase.headers : {}),
        },
      }),
    );
    expect(response.status).toBe(204);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[0]).toContain("SameSite=Lax");
    expect(/; Secure(?:;|$)/.test(cookies[0]!)).toBe(testCase.secure);
    expect(response.headers.get("strict-transport-security")).toBe(
      testCase.hsts ? "max-age=31536000" : null,
    );
  } finally {
    await dispose();
  }
});
