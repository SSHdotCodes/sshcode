import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { fromRunner } from "./textGenerationOperations.ts";

it.effect(
  "rewrites prose through the tool-free utility runner with the selected provider login",
  () =>
    Effect.gen(function* () {
      const selection = { instanceId: ProviderInstanceId.make("fake-login"), model: "test-model" };
      let called = false;
      const generation = fromRunner("Fake", (request) => {
        called = true;
        expect(request.operation).toBe("rewriteProse");
        expect(request.modelSelection).toBe(selection);
        expect(request.investigate).toBeUndefined();
        expect(request.attachments).toBeUndefined();
        expect(request.prompt).toBe("only these prose slots");
        return Schema.decodeUnknownEffect(request.outputSchema)({
          output: "1 say: hey there",
        }).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: request.operation,
                detail: "Fake decode failure",
                cause,
              }),
          ),
        );
      });
      expect(
        yield* generation.rewriteProse!({
          cwd: "/isolated",
          modelSelection: selection,
          prompt: "only these prose slots",
        }),
      ).toEqual({ output: "1 say: hey there" });
      expect(called).toBe(true);
    }),
);
