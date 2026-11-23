import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  ProviderInstanceConfig,
  ProviderInstanceEnvironmentVariable,
  ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";

/** Account limits and provider permissions must not be mistaken for a rejected key. */
export function isRejectedApiCredential(failure: OrchestrationV2ProviderFailure): boolean {
  if (failure.class === "authentication_error") return true;
  if (failure.class !== "provider_error" && failure.class !== "permission_error") return false;
  const text = `${failure.code ?? ""} ${failure.message}`;
  if (
    /quota|rate[ _-]?limit|too many requests|credit|balance|insufficient[ _-]?fund|billing|payment|usage[ _-]?limit|spend(?:ing)?[ _-]?limit|budget|resource[ _-]?exhaust|(?<![0-9])(?:402|429)(?![0-9])/iu.test(
      text,
    )
  )
    return false;
  return /(?:api[ _-]?key|credential)[\s\S]{0,100}(?:expired|invalid|revoked|rejected|incorrect)|(?:expired|invalid|revoked|rejected|incorrect)[\s\S]{0,100}(?:api[ _-]?key|credential)|(?<![0-9])(?:401|403)(?![0-9])|unauthenticated|unauthorized|authentication[ _-]?(?:failed|error|required)/iu.test(
    text,
  );
}

const PROVIDER_KEYS: Readonly<
  Record<string, { name: string; aliases?: ReadonlyArray<string>; label: string; url?: string }>
> = {
  opencode: {
    name: "OPENCODE_API_KEY",
    label: "OpenCode Zen API key",
    url: "https://opencode.ai/auth",
  },
  "opencode-go": {
    name: "OPENCODE_API_KEY",
    label: "OpenCode Go API key",
    url: "https://opencode.ai/auth",
  },
  openrouter: {
    name: "OPENROUTER_API_KEY",
    label: "OpenRouter API key",
    url: "https://openrouter.ai/keys",
  },
  openai: {
    name: "OPENAI_API_KEY",
    label: "OpenAI API key",
    url: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    name: "ANTHROPIC_API_KEY",
    aliases: ["ANTHROPIC_AUTH_TOKEN"],
    label: "Anthropic API key",
    url: "https://console.anthropic.com/settings/keys",
  },
  deepseek: {
    name: "DEEPSEEK_API_KEY",
    label: "DeepSeek API key",
    url: "https://platform.deepseek.com/api_keys",
  },
  mistral: {
    name: "MISTRAL_API_KEY",
    label: "Mistral API key",
    url: "https://console.mistral.ai/api-keys",
  },
  google: {
    name: "GOOGLE_GENERATIVE_AI_API_KEY",
    aliases: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    label: "Google AI API key",
    url: "https://aistudio.google.com/apikey",
  },
};

export function openCodeProvidersForKeyVariable(name: string): ReadonlyArray<string> {
  return Object.entries(PROVIDER_KEYS)
    .filter(([, provider]) => provider.name === name || provider.aliases?.includes(name))
    .map(([id]) => id);
}

export type CredentialTarget =
  | {
      readonly kind: "shared";
      readonly sharedKeyId: string;
      readonly instanceId: ProviderInstanceId;
    }
  | {
      readonly kind: "variable";
      readonly instanceId: ProviderInstanceId;
      readonly variableName: string;
      readonly previousValue: string;
    }
  | {
      readonly kind: "opencode";
      readonly instanceId: ProviderInstanceId;
      readonly providerId: string;
      readonly store: string;
    };

const stringConfig = (instance: ProviderInstanceConfig, name: string): string => {
  const config = instance.config;
  if (typeof config !== "object" || config === null || !(name in config)) return "";
  const value = (config as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
};

/** External servers and alternate homes are separate stores. Unknown wrappers are not grouped. */
export function openCodeCredentialStore(instance: ProviderInstanceConfig): string {
  const url = stringConfig(instance, "serverUrl");
  if (url) return JSON.stringify(["server", url.replace(/\/$/u, "")]);
  const environment = instance.environment ?? [];
  return JSON.stringify([
    "local",
    stringConfig(instance, "binaryPath") || "opencode",
    ...["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "OPENCODE_TEST_HOME"].map(
      (name) => environment.find((variable) => variable.name === name)?.value ?? "",
    ),
  ]);
}

function isKeyVariable(variable: ProviderInstanceEnvironmentVariable): boolean {
  return (
    variable.sharedKey !== undefined ||
    (variable.sensitive &&
      (/(?:API_?KEY|API_TOKEN)$/iu.test(variable.name) || variable.name === "ANTHROPIC_AUTH_TOKEN"))
  );
}

export function resolveCredentialTarget(
  settings: ServerSettings,
  run: Pick<OrchestrationV2Run, "providerInstanceId" | "modelSelection">,
  implicitInstance?: ProviderInstanceConfig,
):
  | { readonly target: CredentialTarget; readonly label: string; readonly consoleUrl?: string }
  | undefined {
  const instanceId = run.providerInstanceId;
  const instance = settings.providerInstances[instanceId] ?? implicitInstance;
  if (!instance) return undefined;
  const providerId =
    instance.driver === "opencode"
      ? /^([\w.-]+)\//u.exec(run.modelSelection.model)?.[1]
      : undefined;
  const provider = providerId === undefined ? undefined : PROVIDER_KEYS[providerId];
  const keys = (instance.environment ?? []).filter(isKeyVariable);
  const key = provider
    ? (keys.find(
        (variable) => variable.name === provider.name || provider.aliases?.includes(variable.name),
      ) ?? (keys.length === 1 && keys[0]?.sharedKey ? keys[0] : undefined))
    : keys.length === 1
      ? keys[0]
      : undefined;
  if (key?.sharedKey && settings.sharedKeys[key.sharedKey]) {
    return {
      target: { kind: "shared", sharedKeyId: key.sharedKey, instanceId },
      label: settings.sharedKeys[key.sharedKey]!.label,
      ...(provider?.url ? { consoleUrl: provider.url } : {}),
    };
  }
  if (key?.sensitive && key.value) {
    return {
      target: { kind: "variable", instanceId, variableName: key.name, previousValue: key.value },
      label: provider?.label ?? key.name,
      ...(provider?.url ? { consoleUrl: provider.url } : {}),
    };
  }
  if (instance.driver !== "opencode" || !providerId) return undefined;
  return {
    target: { kind: "opencode", instanceId, providerId, store: openCodeCredentialStore(instance) },
    label: provider?.label ?? `${providerId} API key`,
    ...(provider?.url ? { consoleUrl: provider.url } : {}),
  };
}

/** Secret comparisons stay on the server; unrelated variables with equal text are left alone. */
export function affectedCredentialInstances(
  settings: ServerSettings,
  target: CredentialTarget,
): ProviderInstanceId[] {
  return Object.entries(settings.providerInstances).flatMap(([id, instance]) => {
    const matches =
      target.kind === "opencode"
        ? instance.driver === "opencode" && openCodeCredentialStore(instance) === target.store
        : instance.environment?.some((variable) =>
            target.kind === "shared"
              ? variable.sharedKey === target.sharedKeyId
              : isKeyVariable(variable) &&
                variable.sharedKey === undefined &&
                variable.value === target.previousValue,
          );
    return matches ? [id as ProviderInstanceId] : [];
  });
}
