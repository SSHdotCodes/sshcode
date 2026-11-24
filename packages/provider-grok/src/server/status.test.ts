import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";

import { GrokSettings } from "../settings.ts";
import { checkGrokProviderStatus } from "./status.ts";

it.layer(NodeServices.layer)("Grok status", (it) => {
  it.effect("discovers account models without initializing ACP in the server workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const binaryPath = writeFakeCli({
        directory: dir,
        name: "grok",
        source: `
          import { readdirSync } from "node:fs";
          import { createInterface } from "node:readline";
          switch (process.argv[2]) {
            case "--version": console.log("grok 1.0.92"); break;
            case "models": console.log("You are logged in with grok.com."); break;
            case "inspect": console.log(JSON.stringify({ skills: [] })); break;
            case "agent": {
              if (readdirSync(".").length > 0) process.exit(1);
              for await (const line of createInterface({ input: process.stdin })) {
                const { id } = JSON.parse(line);
                const modelState = {
                  currentModelId: "grok-test",
                  availableModels: [{ modelId: "grok-test", name: "Grok test" }],
                };
                const result = { protocolVersion: 1, agentCapabilities: {}, _meta: { modelState } };
                console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
              }
              break;
            }
          }
        `,
      });
      const path = yield* Path.Path;
      const snapshot = yield* checkGrokProviderStatus(
        yield* Schema.decodeEffect(GrokSettings)({
          enabled: true,
          binaryPath: path.relative(process.cwd(), binaryPath),
        }),
        { ...process.env, XAI_API_KEY: "" },
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-test"]);
    }),
  );
});
