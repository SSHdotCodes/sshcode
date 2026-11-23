// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export interface T3CodePublicConfig {
  readonly clerkPublishableKey: string | undefined;
  readonly clerkJwtTemplate: string | undefined;
  readonly clerkCliOAuthClientId: string | undefined;
  readonly relayUrl: string | undefined;
  readonly mobileOtlpTracesUrl: string | undefined;
  readonly mobileOtlpTracesDataset: string | undefined;
  readonly mobileOtlpTracesToken: string | undefined;
  readonly relayClientOtlpTracesUrl: string | undefined;
  readonly relayClientOtlpTracesDataset: string | undefined;
  readonly relayClientOtlpTracesToken: string | undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.dirname(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
);

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  if (baseEnv.T3CODE_QA_SANDBOX) return { ...baseEnv };
  const rootEnv = withoutPublicConfig(readEnvFile(NodePath.join(repoRoot, ".env")));
  const localEnv = withoutPublicConfig(readEnvFile(NodePath.join(repoRoot, ".env.local")));
  // A custom Connect deployment is a unit: never mix its Clerk instance with T3's relay.
  const explicit = resolvePublicConfig(baseEnv);
  const example = NodePath.join(repoRoot, ".env.example");
  const useExample =
    !explicit.clerkPublishableKey &&
    !explicit.clerkJwtTemplate &&
    !explicit.clerkCliOAuthClientId &&
    !explicit.relayUrl &&
    NodeFS.existsSync(example);
  const exampleText = useExample ? NodeFS.readFileSync(example, "utf8") : "";
  const config = resolvePublicConfig(
    baseEnv,
    /^T3CODE_(?:CLERK_|RELAY_URL=)/m.test(exampleText) ? selectSharedT3ConnectEnv(exampleText) : {},
  );

  return {
    ...rootEnv,
    ...localEnv,
    ...baseEnv,
    ...(config.clerkPublishableKey
      ? {
          T3CODE_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          VITE_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
        }
      : {}),
    ...(config.clerkJwtTemplate
      ? {
          T3CODE_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          VITE_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          EXPO_PUBLIC_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
        }
      : {}),
    ...(config.clerkCliOAuthClientId
      ? {
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
          VITE_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
        }
      : {}),
    ...(config.relayUrl
      ? {
          T3CODE_RELAY_URL: config.relayUrl,
          VITE_T3CODE_RELAY_URL: config.relayUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesUrl
      ? {
          T3CODE_MOBILE_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
          EXPO_PUBLIC_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesDataset
      ? {
          T3CODE_MOBILE_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
          EXPO_PUBLIC_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
        }
      : {}),
    ...(config.mobileOtlpTracesToken
      ? {
          T3CODE_MOBILE_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
          EXPO_PUBLIC_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
        }
      : {}),
    ...(config.relayClientOtlpTracesUrl
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
          VITE_RELAY_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
        }
      : {}),
    ...(config.relayClientOtlpTracesDataset
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
          VITE_RELAY_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
        }
      : {}),
    ...(config.relayClientOtlpTracesToken
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
          VITE_RELAY_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
        }
      : {}),
  };
}

export function resolvePublicConfig(...sources: readonly Environment[]): T3CodePublicConfig {
  return {
    clerkPublishableKey: firstNonEmpty(
      sources,
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      "VITE_CLERK_PUBLISHABLE_KEY",
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    ),
    clerkJwtTemplate: firstNonEmpty(
      sources,
      "T3CODE_CLERK_JWT_TEMPLATE",
      "VITE_CLERK_JWT_TEMPLATE",
      "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
    ),
    clerkCliOAuthClientId: firstNonEmpty(
      sources,
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
      "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
    ),
    relayUrl: firstNonEmpty(sources, "T3CODE_RELAY_URL", "VITE_T3CODE_RELAY_URL"),
    mobileOtlpTracesUrl: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_URL",
      "EXPO_PUBLIC_OTLP_TRACES_URL",
    ),
    mobileOtlpTracesDataset: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_DATASET",
      "EXPO_PUBLIC_OTLP_TRACES_DATASET",
    ),
    mobileOtlpTracesToken: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_TOKEN",
      "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
    ),
    relayClientOtlpTracesUrl: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
      "VITE_RELAY_OTLP_TRACES_URL",
    ),
    relayClientOtlpTracesDataset: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
      "VITE_RELAY_OTLP_TRACES_DATASET",
    ),
    relayClientOtlpTracesToken: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
      "VITE_RELAY_OTLP_TRACES_TOKEN",
    ),
  };
}

export const SHARED_T3_CONNECT_ENV_KEYS = [
  "T3CODE_CLERK_PUBLISHABLE_KEY",
  "T3CODE_CLERK_JWT_TEMPLATE",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_RELAY_URL",
] as const;

export type SharedT3ConnectEnvKey = (typeof SHARED_T3_CONNECT_ENV_KEYS)[number];

/**
 * Extracts only the four public T3 Connect settings from a `.env` file's text.
 * Every other line (telemetry, passkey RP domains, tokens, personal settings)
 * is ignored, and missing keys report only their key names — never values.
 */
export function selectSharedT3ConnectEnv(
  envFileContent: string,
): Record<SharedT3ConnectEnvKey, string> {
  const parsed = NodeUtil.parseEnv(envFileContent);
  const selected = {} as Record<SharedT3ConnectEnvKey, string>;
  const missing: string[] = [];

  for (const key of SHARED_T3_CONNECT_ENV_KEYS) {
    const value = parsed[key]?.trim();
    if (!value) {
      missing.push(key);
    } else {
      selected[key] = value;
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required T3 Connect keys in .env: ${missing.join(", ")}`);
  }

  return selected;
}

/**
 * Every name `resolvePublicConfig` reads. Repo `.env` files never supply these
 * implicitly; only an explicit process environment (such as the four public T3
 * Connect settings loaded by `build-shared-dmg.sh`) can provide them.
 */
const PUBLIC_CONFIG_NAMES: ReadonlySet<string> = new Set([
  "T3CODE_CLERK_PUBLISHABLE_KEY",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "T3CODE_CLERK_JWT_TEMPLATE",
  "VITE_CLERK_JWT_TEMPLATE",
  "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_CLERK_PASSKEY_RP_DOMAINS",
  "T3CODE_RELAY_URL",
  "VITE_T3CODE_RELAY_URL",
  "T3CODE_MOBILE_OTLP_TRACES_URL",
  "EXPO_PUBLIC_OTLP_TRACES_URL",
  "T3CODE_MOBILE_OTLP_TRACES_DATASET",
  "EXPO_PUBLIC_OTLP_TRACES_DATASET",
  "T3CODE_MOBILE_OTLP_TRACES_TOKEN",
  "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
  "VITE_RELAY_OTLP_TRACES_URL",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
  "VITE_RELAY_OTLP_TRACES_DATASET",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
  "VITE_RELAY_OTLP_TRACES_TOKEN",
]);

function withoutPublicConfig(env: Environment): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !PUBLIC_CONFIG_NAMES.has(name)));
}

function firstNonEmpty(sources: readonly Environment[], ...names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}

/** The mobile app's bundle identifier when a build sets none of its own. */
export const DEFAULT_MOBILE_BUNDLE_IDENTIFIER = "io.github.sshdotcodes.sshcode";

/**
 * The reverse-DNS base the mobile variants build on (`<base>.dev`, `<base>.preview`, `<base>`),
 * from `T3CODE_IOS_BUNDLE_ID` in the repository-root .env.
 */
export function mobileBundleIdentifierBase(env: Environment): string {
  return env.T3CODE_IOS_BUNDLE_ID?.trim() || DEFAULT_MOBILE_BUNDLE_IDENTIFIER;
}
