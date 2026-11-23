import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AgentToolProviderPolicy = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  tools: Schema.Record(Schema.String, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export const AgentToolPolicy = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  tools: Schema.Record(Schema.String, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  providers: Schema.Record(ProviderInstanceId, AgentToolProviderPolicy).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type AgentToolPolicy = typeof AgentToolPolicy.Type;
export const DEFAULT_AGENT_TOOL_POLICY = Schema.decodeSync(AgentToolPolicy)({});

/**
 * Provider choices override global defaults; a missing policy leaves every SSHCode tool enabled.
 * `providers` is keyed by `ProviderInstanceId`, so a plain string is branded before lookup.
 */
export function isAgentToolEnabled(policy: AgentToolPolicy, tool: string, provider?: string) {
  const override =
    provider === undefined ? undefined : policy.providers[ProviderInstanceId.make(provider)];
  return override?.tools[tool] ?? override?.enabled ?? policy.tools[tool] ?? policy.enabled;
}

export const AgentToolDescriptor = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  group: Schema.String,
  readonly: Schema.Boolean,
});
export const AgentToolsState = Schema.Struct({
  policy: AgentToolPolicy,
  tools: Schema.Array(AgentToolDescriptor),
});
export type AgentToolsState = typeof AgentToolsState.Type;
