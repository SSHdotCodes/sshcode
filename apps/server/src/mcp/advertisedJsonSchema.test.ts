import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { ScheduleTaskTool } from "./toolkits/orchestrator/tools.ts";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema, advertisedOutputSchema } from "./advertisedJsonSchema.ts";

it("leaves literal data under const, enum, default and examples as written", () => {
  const literal = {
    description: "x",
    allOf: [{ description: "x" }],
    additionalProperties: true,
    maximum: Number.MAX_SAFE_INTEGER,
  };
  const source = {
    type: "object",
    const: literal,
    enum: [literal],
    default: literal,
    examples: [literal],
  };
  const compact = advertisedOutputSchema(source);
  expect(compact).toEqual(source);
  const original = new AjvJsonSchemaValidator().getValidator(source as JsonSchemaType);
  const advertised = new AjvJsonSchemaValidator().getValidator(compact as JsonSchemaType);
  const { allOf: _allOf, ...withoutAllOf } = literal;
  for (const value of [literal, withoutAllOf, {}])
    expect(advertised(value).valid).toBe(original(value).valid);
});

it("removes duplicated allOf annotations while retaining constraints and distinct guidance", () => {
  const source = {
    type: "string",
    description: "Expression.",
    minLength: 1,
    allOf: [
      { description: "Expression." },
      { maxLength: 4, description: "At most four characters." },
    ],
  };
  const compact = advertisedOutputSchema(source);
  expect(compact.allOf).toEqual([{ maxLength: 4, description: "At most four characters." }]);
  const original = new AjvJsonSchemaValidator().getValidator(source as JsonSchemaType);
  const advertised = new AjvJsonSchemaValidator().getValidator(compact as JsonSchemaType);
  for (const value of ["", "ok", "longer", 3, null])
    expect(advertised(value).valid).toBe(original(value).valid);
  expect(
    advertisedOutputSchema({
      type: "string",
      description: "Same.",
      allOf: [{ description: "Same." }],
    }),
  ).toEqual({ type: "string", description: "Same." });
  expect(source.allOf).toHaveLength(2);
});

it("drops JSON noise, merges tagged unions, and keeps explicit nulls, including optional clear operations", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: ["string", "null"] },
      beforeRunId: { type: ["string", "null"] },
      limit: { type: ["integer", "null"] },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        type: ["object", "null"],
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("preserves strict object boundaries when flattening an action union", () => {
  const tool = Tool.make("strict", {
    parameters: Schema.Union([
      Schema.Struct({ action: Schema.Literal("read"), id: Schema.String }),
      Schema.Struct({ action: Schema.Literal("write"), id: Schema.String, text: Schema.String }),
    ]),
  }).annotate(Tool.Strict, true);
  expect(advertisedJsonSchema(tool)).toMatchObject({
    type: "object",
    additionalProperties: false,
    required: ["action", "id"],
  });
});

it("keeps numeric discriminators valid instead of merging them into a string tag", () => {
  const tool = Tool.make("numeric", {
    parameters: Schema.Union([
      Schema.Struct({ kind: Schema.Literal(1), text: Schema.String }),
      Schema.Struct({ kind: Schema.Literal(2), count: Schema.Int }),
    ]),
  });
  const validate = new AjvJsonSchemaValidator().getValidator(
    advertisedJsonSchema(tool) as JsonSchemaType,
  );
  expect(validate({ kind: 1, text: "value" }).valid).toBe(true);
  expect(validate({ kind: 2, count: 3 }).valid).toBe(true);
});

it("advertises explicit nulls used to clear settings, signatures and reorder destinations", () => {
  for (const [tool, input] of [
    [ThreadToolkit.tools.t3_queue, { action: "reorder", queuedRunId: "queued", beforeRunId: null }],
    [
      ProjectToolkit.tools.t3_project_update,
      { projectId: "project", defaultModelSelection: null, faviconPath: null },
    ],
    [
      ScheduleTaskTool,
      { scheduledTaskId: "schedule", schedule: { type: "webhook", signature: null } },
    ],
  ] as const) {
    const validate = new AjvJsonSchemaValidator().getValidator(
      advertisedJsonSchema(tool) as JsonSchemaType,
    );
    expect(validate(input).valid, tool.name).toBe(true);
  }
});

it("compacts nullable enums without changing bounds, required fields or descriptive guidance", () => {
  const tool = Tool.make("nullable", {
    parameters: Schema.Struct({
      mode: Schema.NullOr(Schema.Literals(["fast", "safe"])),
      count: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
      name: Schema.NullOr(Schema.String.check(Schema.isMinLength(2))),
      detail: Schema.NullOr(Schema.Struct({ id: Schema.String })),
      timeout: Schema.optional(
        Schema.Int.annotate({ description: "Milliseconds; default 1000." }),
      ).annotate({ description: "Maximum wait." }),
    }),
  });
  const validate = new AjvJsonSchemaValidator().getValidator(
    advertisedJsonSchema(tool) as JsonSchemaType,
  );
  const valid = { mode: "safe", count: 1, name: "ok", detail: { id: "a" } };
  expect(validate(valid).valid).toBe(true);
  expect(validate({ mode: null, count: null, name: null, detail: null }).valid).toBe(true);
  for (const invalid of [
    { ...valid, mode: "other" },
    { ...valid, count: 0 },
    { ...valid, count: 11 },
    { ...valid, count: 1.5 },
    { ...valid, name: "" },
    { ...valid, detail: {} },
    { mode: null },
  ])
    expect(validate(invalid).valid).toBe(false);
  const json = JSON.stringify(advertisedJsonSchema(tool));
  expect(json).toContain("Milliseconds; default 1000.");
  expect(json).toContain("Maximum wait.");
  expect(json.length).toBeLessThan(JSON.stringify(Tool.getJsonSchema(tool)).length);
});

it("compacts output noise while preserving discriminated branch requirements and constraints", () => {
  const source = {
    type: "object",
    properties: {
      result: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["ok"] },
              count: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            },
            required: ["kind", "count"],
            additionalProperties: true,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["error"] },
              message: { type: "string", minLength: 1 },
            },
            required: ["kind", "message"],
            additionalProperties: true,
          },
          { type: "null" },
        ],
      },
    },
    required: ["result"],
    additionalProperties: true,
  };
  const compact = advertisedOutputSchema(source);
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(source).length);
  const validate = new AjvJsonSchemaValidator().getValidator(compact as JsonSchemaType);
  for (const result of [{ kind: "ok", count: 1 }, { kind: "error", message: "failed" }, null])
    expect(validate({ result }).valid).toBe(true);
  for (const result of [
    { kind: "ok" },
    { kind: "error" },
    { kind: "ok", message: "wrong branch" },
    { kind: "error", count: 1 },
    { kind: "ok", count: 0 },
    { kind: "error", message: "" },
  ])
    expect(validate({ result }).valid).toBe(false);
  expect(source.additionalProperties).toBe(true);
});
