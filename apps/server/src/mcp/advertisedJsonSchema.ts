import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { Tool } from "effect/ai";

type Json = unknown;
type JsonObject = { [key: string]: Json };

const isNullSchema = (value: Json) =>
  Predicate.isObject(value) && value.type === "null" && Object.keys(value).length === 1;

const isBareAnyOf = (value: Json): value is { anyOf: Array<Json> } =>
  Predicate.isObject(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;

// A `Schema.fromJsonString` fallback. Advertised beside object shapes, it invites stringified input.
const isJsonStringSchema = (value: Json) =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  value.contentMediaType === "application/json";

/** Values, not schemas: compacting inside them would change what they allow. */
const DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);
const BOUND_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);

const SAFE_INTEGER_BOUNDS: Record<string, number> = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: Number.MIN_SAFE_INTEGER,
};

const tagOf = (branch: JsonObject, key: string): Json => {
  const property = Predicate.isObject(branch.properties) ? branch.properties[key] : undefined;
  return Predicate.isObject(property) && Array.isArray(property.enum) && property.enum.length === 1
    ? property.enum[0]
    : undefined;
};

/** Combine literal-only branches without dropping validation or per-choice guidance. */
const mergeLiteralEnums = (
  branches: ReadonlyArray<Json>,
): { type: string; enum: ReadonlyArray<unknown> } | undefined => {
  if (branches.length < 2) return undefined;
  const first = branches[0];
  if (
    !Predicate.isObject(first) ||
    (first.type !== "string" &&
      first.type !== "integer" &&
      first.type !== "number" &&
      first.type !== "boolean")
  )
    return undefined;
  const choices = new Set<unknown>();
  for (const branch of branches) {
    if (
      !Predicate.isObject(branch) ||
      branch.type !== first.type ||
      Object.keys(branch).length !== 2
    )
      return undefined;
    if (Array.isArray(branch.enum)) {
      for (const value of branch.enum) choices.add(value);
    } else if ("const" in branch) {
      choices.add(branch.const);
    } else {
      return undefined;
    }
  }
  return { type: first.type, enum: [...choices] };
};

/** One object for a tagged union of objects: each property once, the tag listing every value. */
const mergeTaggedObjects = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length < 2) return undefined;
  const objects = branches.filter(
    (branch): branch is JsonObject & { properties: JsonObject } =>
      Predicate.isObject(branch) &&
      branch.type === "object" &&
      Predicate.isObject(branch.properties),
  );
  if (objects.length !== branches.length) return undefined;
  const tag = Object.keys(objects[0]!.properties).find((key) => {
    const values = objects.map((object) => tagOf(object, key));
    return (
      values.every((value) => typeof value === "string") && new Set(values).size === values.length
    );
  });
  if (tag === undefined) return undefined;
  const properties: JsonObject = {
    [tag]: { type: "string", enum: objects.map((object) => tagOf(object, tag)) },
  };
  for (const object of objects) {
    for (const [name, property] of Object.entries(object.properties)) {
      if (name === tag) continue;
      const seen = properties[name];
      if (seen === undefined) properties[name] = property;
      else if (JSON.stringify(seen) !== JSON.stringify(property)) {
        const options = Predicate.isObject(seen) && isBareAnyOf(seen) ? seen.anyOf : [seen];
        if (!options.some((option) => JSON.stringify(option) === JSON.stringify(property)))
          properties[name] = { anyOf: [...options, property] };
      }
    }
  }
  const [first = [], ...others] = objects.map((object) =>
    Array.isArray(object.required) ? object.required : [],
  );
  const requiredByAll = first.filter(
    (name) => name !== tag && others.every((required) => required.includes(name)),
  );
  return {
    type: "object",
    properties,
    required: [tag, ...requiredByAll],
    ...(objects.every((object) => object.additionalProperties === false)
      ? { additionalProperties: false }
      : {}),
  };
};

const compact = (schema: Json, mergeTags = true): Json => {
  if (Array.isArray(schema)) return schema.map((item) => compact(item, mergeTags));
  if (!Predicate.isObject(schema)) return schema;
  let result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === true) continue;
    if (SAFE_INTEGER_BOUNDS[key] === value) continue;
    result[key] = DATA_KEYWORDS.has(key)
      ? value
      : key === "properties" && Predicate.isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, property]) => [name, compact(property, mergeTags)]),
          )
        : compact(value, mergeTags);
  }
  // Effect can emit the same annotation both on a field and in allOf.
  // Remove only an annotation that adds neither a constraint nor new guidance.
  if (Array.isArray(result.allOf)) {
    const branches = result.allOf.filter((branch) => {
      if (!Predicate.isObject(branch)) return true;
      const keys = Object.keys(branch);
      if (
        keys.length === 1 &&
        typeof result.description === "string" &&
        branch.description === result.description
      )
        return false;
      if (
        "type" in result &&
        !("$ref" in result) &&
        keys.every((key) => BOUND_KEYWORDS.has(key) && !(key in result))
      ) {
        Object.assign(result, branch);
        return false;
      }
      return true;
    });
    if (branches.length === 0) delete result.allOf;
    else result.allOf = branches;
  }
  if (Array.isArray(result.anyOf)) {
    const candidates = result.anyOf
      .flatMap((branch) => (isBareAnyOf(branch) ? branch.anyOf : [branch]))
      .filter(
        (branch, index, all) =>
          all.findIndex((other) => JSON.stringify(other) === JSON.stringify(branch)) === index,
      );
    const ordinary = candidates.filter((branch) => !isJsonStringSchema(branch));
    const branches = ordinary.some((branch) => !isNullSchema(branch)) ? ordinary : candidates;
    const { anyOf: _anyOf, ...rest } = result;
    const nulls = branches.filter(isNullSchema);
    const objects = branches.filter((branch) => !isNullSchema(branch));
    const literals =
      "type" in rest || "enum" in rest || "const" in rest ? undefined : mergeLiteralEnums(objects);
    const merged = mergeTags ? mergeTaggedObjects(objects) : undefined;
    if (literals !== undefined && nulls.length === 1) {
      return {
        ...rest,
        type: [literals.type, "null"],
        enum: [...literals.enum, null],
      };
    }
    const options =
      literals === undefined && merged === undefined ? branches : [literals ?? merged, ...nulls];
    const only = options.length === 1 ? options[0] : undefined;
    result = Predicate.isObject(only) ? { ...only, ...rest } : { ...rest, anyOf: options };
    // Nullable primitives/objects need no separate anyOf wrapper. Preserve all
    // validation constraints and include null in enum when it restricts values.
    if (nulls.length === 1 && objects.length === 1 && merged === undefined) {
      const branch = objects[0];
      if (
        Predicate.isObject(branch) &&
        Array.isArray(branch.type) &&
        branch.type.includes("null") &&
        !(
          typeof branch.description === "string" &&
          typeof rest.description === "string" &&
          branch.description !== rest.description
        )
      ) {
        result = { ...branch, ...rest };
      }
      if (
        Predicate.isObject(branch) &&
        typeof branch.type === "string" &&
        branch.const === undefined &&
        !(
          typeof branch.description === "string" &&
          typeof rest.description === "string" &&
          branch.description !== rest.description
        )
      ) {
        result = {
          ...branch,
          ...rest,
          type: [branch.type, "null"],
          ...(Array.isArray(branch.enum) ? { enum: [...branch.enum, null] } : {}),
        };
      }
    }
    if (Array.isArray(result.anyOf) && typeof result.description === "string") {
      result.anyOf = result.anyOf.map((branch) => {
        if (!Predicate.isObject(branch) || branch.description !== result.description) return branch;
        const { description: _description, ...withoutDuplicate } = branch;
        return withoutDuplicate;
      });
    }
  }
  return result;
};

/** MCP requires an object type at the root, including for unions of objects. */
export const advertisedOutputSchema = <T>(schema: T): T => {
  const output = compact(schema, false);
  if (
    Predicate.isObject(output) &&
    output.type === undefined &&
    (Object.keys(output).length === 0 ||
      (Array.isArray(output.anyOf) &&
        output.anyOf.every((branch) => Predicate.isObject(branch) && branch.type === "object")))
  )
    return { type: "object", ...output } as T;
  return output as T;
};

/**
 * The input schema T3 advertises for a tool. Drops JSON noise that every thread pays for:
 * `additionalProperties: true`, safe-integer bounds, nested `anyOf`, JSON-string fallbacks, and
 * redundant union structure and descriptions. Nullable fields stay nullable, including optional reset/clear inputs.
 * A tagged union of objects becomes one object.
 * Decoding still uses the full schema, so each tag's own required fields still apply.
 */
export const advertisedJsonSchema = (tool: Tool.Any) => {
  if (Tool.getStrictMode(tool) !== true)
    return compact(Tool.getJsonSchema(tool)) as ReturnType<typeof Tool.getJsonSchema>;
  const document = Schema.toJsonSchemaDocument(tool.parametersSchema, {
    onExcessProperty: "error",
  });
  return compact({
    ...document.schema,
    ...(Object.keys(document.definitions).length ? { $defs: document.definitions } : {}),
  }) as ReturnType<typeof Tool.getJsonSchema>;
};

const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "dependentSchemas",
]);
const SCHEMA_ANNOTATIONS = new Set(["description", "title", "examples", "$comment"]);
const PROVIDER_SLUG_PATTERN = "^[a-zA-Z][a-zA-Z0-9_-]*$";

/** Compact the declaration sent to eager models. The tool's decoder still
 * enforces the original input schema, including text-size limits. */
export const compactAdvertisedInput = (
  schema: Json,
  fieldGuidance: (field: string) => string | undefined,
): Json => {
  const project = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(project);
    if (!Predicate.isObject(value)) return value;
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (SCHEMA_ANNOTATIONS.has(key) || (key === "minLength" && child === 1)) continue;
      if (key === "maxLength" || (key === "minItems" && child === 1)) continue;
      if (key === "pattern" && child === PROVIDER_SLUG_PATTERN) continue;
      if (key === "minimum" && child === 0) continue;
      if (DATA_KEYWORDS.has(key)) {
        result[key] = child;
      } else if (SCHEMA_MAP_KEYWORDS.has(key) && Predicate.isObject(child)) {
        result[key] = Object.fromEntries(
          Object.entries(child).map(([name, definition]) => {
            const projected = project(definition);
            const description = key === "properties" ? fieldGuidance(name) : undefined;
            return [
              name,
              description !== undefined && Predicate.isObject(projected)
                ? { ...projected, description }
                : projected,
            ];
          }),
        );
      } else {
        result[key] = project(child);
      }
    }
    return result;
  };
  // Removing prose can make enum or union branches identical.
  return compact(project(schema));
};
