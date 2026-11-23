import { describe, expect, it } from "vite-plus/test";
import { environmentLabels } from "./environmentLabels.ts";

describe("environment display labels", () => {
  it("leaves unique names alone", () => {
    expect([
      ...environmentLabels([{ id: "a", label: "Mac", address: "https://mac:3774" }]),
    ]).toEqual([["a", "Mac"]]);
    expect([...environmentLabels([])]).toEqual([]);
  });

  it("adds hostnames without ports, paths, credentials, or schemes", () => {
    const labels = environmentLabels([
      { id: "a", label: "Mac", address: "https://user:password@Mac.Local:3774/path?query#hash" },
      { id: "b", label: "Mac", address: "other.local:8080/path" },
      { id: "c", label: "Server", host: "server.local:8080" },
    ]);
    expect([...labels]).toEqual([
      ["a", "Mac · mac.local"],
      ["b", "Mac · other.local"],
      ["c", "Server"],
    ]);
  });

  it("handles IPv4, IPv6 and bare host input", () => {
    expect([
      ...environmentLabels([
        { id: "a", label: "QA", address: "http://127.0.0.1:1234" },
        { id: "b", label: "QA", host: "[::1]:4321" },
        { id: "c", label: "QA", address: "", host: "sandbox.local" },
      ]),
    ]).toEqual([
      ["a", "QA · 127.0.0.1"],
      ["b", "QA · ::1"],
      ["c", "QA · sandbox.local"],
    ]);
  });

  it("numbers host collisions by id, independent of discovery order or port", () => {
    const environments = [
      { id: "c", label: "Mac", address: "http://localhost:3000" },
      { id: "a", label: "Mac", address: "ws://localhost:1000" },
      { id: "b", label: "Mac", address: "https://localhost:2000" },
    ];
    const expected = [
      ["a", "Mac"],
      ["b", "Mac 2"],
      ["c", "Mac 3"],
    ];
    expect([...environmentLabels(environments)]).toEqual(expected);
    expect([...environmentLabels([...environments].reverse())]).toEqual(expected);
  });

  it("keeps mixed and missing host collisions unambiguous without mutating input", () => {
    const environments = Object.freeze([
      Object.freeze({ id: "c", label: "Mac", host: "another" }),
      Object.freeze({ id: "a", label: "Mac", host: "same" }),
      Object.freeze({ id: "b", label: "Mac", host: "same" }),
    ]);
    expect([...environmentLabels(environments)]).toEqual([
      ["a", "Mac"],
      ["b", "Mac 2"],
      ["c", "Mac 3"],
    ]);
    expect([
      ...environmentLabels([
        { id: "b", label: "QA" },
        { id: "a", label: "QA" },
      ]),
    ]).toEqual([
      ["a", "QA"],
      ["b", "QA 2"],
    ]);
    expect(environments[0]?.id).toBe("c");
  });
});
