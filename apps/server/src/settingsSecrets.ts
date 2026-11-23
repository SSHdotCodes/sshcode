import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  type ServerSettings,
  UsageLimitSourceConfig,
  secretSettingsFields,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";
import {
  readSecretFieldValues,
  SOURCE_CONTROL_HOST_SECRET_FIELDS,
  sourceControlHostSecretName,
  writeSecretFieldValues,
} from "./sourceControl/sourceControlHostSecrets.ts";

export const SECRET_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

const providerSecretFields = new Map([
  ["codex", secretSettingsFields(CodexSettings)],
  ["claudeAgent", secretSettingsFields(ClaudeSettings)],
  ["antigravity", secretSettingsFields(AntigravitySettings)],
  ...[cursorClient, grokClient, museClient, openCodeClient, piClient, acpRegistryClient].map(
    (definition) =>
      [definition.driverKind, secretSettingsFields(definition.settingsSchema)] as const,
  ),
]);
const usageLimitSecretFields = secretSettingsFields(UsageLimitSourceConfig);
const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

export interface SettingsSecret {
  readonly secretName: string;
  readonly kind: "field" | "environment";
  readonly value: string;
  readonly redacted: boolean;
  readonly sensitive: boolean;
  readonly providerInstanceId?: string;
  readonly environmentVariable?: string;
  /** A variable whose value comes from a shared key; it never stores its own. */
  readonly linked?: boolean;
}

type SecretValue = Pick<SettingsSecret, "value" | "redacted">;

/**
 * Visits credential fields declared by schemas and dynamically sensitive environment variables.
 * Store keys and client representations stay here; callers supply only the secret operation.
 */
export function mapSettingsSecrets(
  settings: ServerSettings,
  map: (secret: SettingsSecret) => SecretValue,
): ServerSettings {
  const mapFields = (
    fields: Readonly<Record<string, unknown>>,
    secretFields: ReadonlyArray<string>,
    name: (field: string, serverHost: string | null) => string,
  ) => {
    const next = { ...fields };
    for (const field of secretFields) {
      if (!(field in next)) continue;
      next[field] = writeSecretFieldValues(
        next[field],
        readSecretFieldValues(next[field]).map(([serverHost, value]) => {
          const result = map({
            secretName: name(field, serverHost),
            kind: "field",
            value,
            redacted: value === SECRET_REDACTED,
            sensitive: true,
          });
          return [serverHost, result.redacted ? SECRET_REDACTED : result.value] as const;
        }),
      );
    }
    return next;
  };

  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => {
      const config = instance.config;
      return [
        instanceId,
        {
          ...instance,
          ...(config !== null && typeof config === "object" && !Array.isArray(config)
            ? {
                config: mapFields(
                  config as Record<string, unknown>,
                  providerSecretFields.get(instance.driver) ?? [],
                  (field, serverHost) =>
                    `provider-config-${encode(instanceId)}-${encode(instance.driver)}-${encode(field)}` +
                    (serverHost === null ? "" : `-${encode(serverHost)}`),
                ),
              }
            : {}),
          ...(instance.environment
            ? {
                environment: instance.environment.map((variable) => {
                  const result = map({
                    secretName: `provider-env-${encode(instanceId)}-${encode(variable.name)}`,
                    kind: "environment",
                    value: variable.value,
                    redacted: variable.valueRedacted === true,
                    sensitive: variable.sensitive,
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                    ...(variable.sharedKey !== undefined ? { linked: true } : {}),
                  });
                  const { valueRedacted: _omit, ...rest } = variable;
                  return {
                    ...rest,
                    value: result.value,
                    ...(result.redacted ? { valueRedacted: true } : {}),
                  };
                }),
              }
            : {}),
        },
      ];
    }),
  );

  const sourceControlHosts = Object.fromEntries(
    Object.entries(settings.sourceControlHosts).map(([kind, fields]) => [
      kind,
      mapFields(fields, SOURCE_CONTROL_HOST_SECRET_FIELDS.get(kind) ?? [], (field, serverHost) =>
        sourceControlHostSecretName({ kind, field, serverHost }),
      ),
    ]),
  ) as ServerSettings["sourceControlHosts"];

  const usageLimitSources = Object.fromEntries(
    Object.entries(settings.usageLimitSources).map(([id, source]) => [
      id,
      mapFields(
        source,
        usageLimitSecretFields,
        (field, serverHost) =>
          `usage-limit-source-${encode(id)}` +
          (field === "managementKey" && serverHost === null
            ? ""
            : `-${encode(field)}${serverHost === null ? "" : `-${encode(serverHost)}`}`),
      ),
    ]),
  ) as ServerSettings["usageLimitSources"];

  const sharedKeys = Object.fromEntries(
    Object.entries(settings.sharedKeys).map(([id, key]) => {
      const result = map({
        secretName: `shared-key-${encode(id)}`,
        kind: "environment",
        value: key.value,
        redacted: key.valueRedacted === true,
        sensitive: true,
      });
      const { valueRedacted: _omit, ...rest } = key;
      return [
        id,
        { ...rest, value: result.value, ...(result.redacted ? { valueRedacted: true } : {}) },
      ];
    }),
  ) as ServerSettings["sharedKeys"];

  return { ...settings, providerInstances, sourceControlHosts, usageLimitSources, sharedKeys };
}

/**
 * Fills each linked variable from its shared key. Runs on materialized
 * settings only (real values), never on what gets persisted, so a shared key
 * is stored once however many instances use it.
 */
export function resolveSharedKeyLinks(settings: ServerSettings): ServerSettings {
  let changed = false;
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => {
      if (!instance.environment?.some((variable) => variable.sharedKey !== undefined)) {
        return [instanceId, instance];
      }
      changed = true;
      return [
        instanceId,
        {
          ...instance,
          environment: instance.environment.map((variable) => {
            if (variable.sharedKey === undefined) return variable;
            const value = settings.sharedKeys[variable.sharedKey]?.value ?? "";
            const { valueRedacted: _omit, ...rest } = variable;
            return {
              ...rest,
              value,
              sensitive: true,
              ...(value.length > 0 ? { valueRedacted: true } : {}),
            };
          }),
        },
      ];
    }),
  ) as ServerSettings["providerInstances"];
  return changed ? { ...settings, providerInstances } : settings;
}
