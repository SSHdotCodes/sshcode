import { expect, it } from "vite-plus/test";
import { delegatedTaskHandle } from "./delegatedTaskHandle.ts";

it("matches the server's short handle for a delegated task", () => {
  // A real subagent id and the taskId its delegate_task call returned.
  expect(
    delegatedTaskHandle(
      "node:delegated-task:command%3Amcp%3A80f803be-5f93-424b-9bdb-2b0ba5454218%3Adelegate-task%3Afeel-round-neon-1",
    ),
  ).toBe("tURvKe5xB1W4KMb4");
  expect(delegatedTaskHandle("short-id")).toBe("short-id");
});
