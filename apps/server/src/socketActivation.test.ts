import { describe, expect, it } from "vite-plus/test";

import * as NodeEvents from "node:events";

import { holdEarlyRequests, systemdListenFd } from "./socketActivation.ts";

describe("systemdListenFd", () => {
  it("claims fd 3 only when systemd addressed this process", () => {
    expect(systemdListenFd({ LISTEN_PID: "42", LISTEN_FDS: "1" }, 42)).toBe(3);
    expect(systemdListenFd({ LISTEN_PID: "41", LISTEN_FDS: "1" }, 42)).toBeNull();
    expect(systemdListenFd({ LISTEN_PID: "42", LISTEN_FDS: "0" }, 42)).toBeNull();
    expect(systemdListenFd({}, 42)).toBeNull();
  });
});

describe("holdEarlyRequests", () => {
  it("replays a request and an upgrade that arrived before the handlers", async () => {
    const emitter = new NodeEvents.EventEmitter();
    // An error guard listens first and never answers.
    emitter.on("request", () => {});
    emitter.on("upgrade", () => {});
    const server = holdEarlyRequests(emitter);
    server.emit("request", "early-request", "response");
    server.emit("upgrade", "early-upgrade", "socket", "head");
    const seen: Array<string> = [];
    server.on("request", (request: string) => seen.push(request));
    server.on("upgrade", (request: string) => seen.push(request));
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual(["early-request", "early-upgrade"]);
    server.emit("request", "later");
    expect(seen).toEqual(["early-request", "early-upgrade", "later"]);
    expect(server.listenerCount("request")).toBe(2);
  });
});
