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
    const branches = result.allOf.filter(
      (branch) =>
        !(
          Predicate.isObject(branch) &&
          Object.keys(branch).length === 1 &&
          typeof result.description === "string" &&
          branch.description === result.description
        ),
    );
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
    const merged = mergeTags ? mergeTaggedObjects(objects) : undefined;
    const options = merged === undefined ? branches : [merged, ...nulls];
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

/** Output types must retain each union branch's required fields. */
export const advertisedOutputSchema = <T>(schema: T): T => compact(schema, false) as T;

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
