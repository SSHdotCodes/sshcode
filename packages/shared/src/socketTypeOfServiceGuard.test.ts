import { expect, it } from "vite-plus/test";

import { guardSocketTypeOfService } from "./socketTypeOfServiceGuard.ts";

it("swallows a refused socket marking instead of letting it kill the process", () => {
  const calls: unknown[] = [];
  const socket = {
    setTypeOfService(value: unknown) {
      calls.push(value);
      if (value === "refused") {
        throw Object.assign(new Error("setTypeOfService EINVAL"), { code: "EINVAL" });
      }
      return "marked";
    },
  };
  guardSocketTypeOfService(socket);

  expect(socket.setTypeOfService("refused")).toBe(socket);
  // A marking the system accepts still goes through untouched.
  expect(socket.setTypeOfService(16)).toBe("marked");
  expect(calls).toEqual(["refused", 16]);
});

it("leaves a runtime without the method alone", () => {
  const socket = {};
  guardSocketTypeOfService(socket);
  expect(socket).toEqual({});
});
