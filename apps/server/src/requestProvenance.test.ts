import { expect, it } from "@effect/vitest";
import {
  hasDirectLocalHost,
  isDirectLocalRequest,
  requestProvenance,
} from "./requestProvenance.ts";

const local = { hostname: "localhost", remoteAddress: "127.0.0.1", protocol: "http:", headers: {} };
it("requires both local host and socket for local capabilities", () => {
  expect(isDirectLocalRequest(requestProvenance(local))).toBe(true);
  for (const input of [
    { ...local, hostname: "relay.example" },
    { ...local, hostname: undefined },
    { ...local, remoteAddress: undefined },
    { ...local, remoteAddress: "203.0.113.1" },
    { ...local, hostname: "studio.localhost" },
  ])
    expect(isDirectLocalRequest(requestProvenance(input))).toBe(false);
});

it.each([
  "cf-connecting-ip",
  "cf-ray",
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
])("treats a loopback relay with %s as non-local, even with an empty header", (header) => {
  for (const value of ["fake-relay", ""]) {
    const provenance = requestProvenance({ ...local, headers: { [header]: value } });
    expect(provenance.socketLocal).toBe(true);
    expect(provenance.proxied).toBe(true);
    expect(isDirectLocalRequest(provenance)).toBe(false);
    expect(hasDirectLocalHost(provenance)).toBe(false);
  }
});
