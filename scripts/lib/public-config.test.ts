// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  SHARED_T3_CONNECT_ENV_KEYS,
  loadRepoEnv,
  resolvePublicConfig,
  selectSharedT3ConnectEnv,
} from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("does not project cloud configuration for an unconfigured clone", () => {
    const env = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });

    expect(env.T3CODE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.T3CODE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.VITE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.T3CODE_RELAY_URL).toBeUndefined();
    expect(env.VITE_T3CODE_RELAY_URL).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_URL).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_URL).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_TOKEN).toBeUndefined();
  });

  it("never takes relay, Clerk, or tracing values from the repo env files", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nVITE_CLERK_JWT_TEMPLATE=template_root\nT3CODE_RELAY_URL=https://root.example.test\nT3CODE_DEV_AUTH_TOKEN=dev_root\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nVITE_RELAY_OTLP_TRACES_TOKEN=token_local\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot })).toEqual({ T3CODE_DEV_AUTH_TOKEN: "dev_root" });
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });

  it("accepts legacy framework aliases as root overrides", () => {
    expect(
      resolvePublicConfig({
        VITE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
        VITE_CLERK_JWT_TEMPLATE: "template_legacy",
        T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_canonical",
        VITE_T3CODE_RELAY_URL: "https://legacy.example.test",
        EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
        EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
        EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
      }),
    ).toEqual({
      clerkPublishableKey: "pk_legacy",
      clerkJwtTemplate: "template_legacy",
      clerkCliOAuthClientId: "oauth_canonical",
      relayUrl: "https://legacy.example.test",
      mobileOtlpTracesUrl: "https://api.axiom.co/v1/traces",
      mobileOtlpTracesDataset: "mobile-traces",
      mobileOtlpTracesToken: "mobile-token",
      relayClientOtlpTracesUrl: undefined,
      relayClientOtlpTracesDataset: undefined,
      relayClientOtlpTracesToken: undefined,
    });
  });

  it("projects canonical relay client tracing values to web build aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
          T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
      VITE_RELAY_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      VITE_RELAY_OTLP_TRACES_DATASET: "relay-client-traces",
      VITE_RELAY_OTLP_TRACES_TOKEN: "relay-client-token",
    });
  });

  it("projects canonical mobile tracing values to Expo public aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_RELAY_URL: "https://relay.example.test",
          T3CODE_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          T3CODE_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
          T3CODE_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      T3CODE_RELAY_URL: "https://relay.example.test",
      VITE_T3CODE_RELAY_URL: "https://relay.example.test",
      T3CODE_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      T3CODE_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
      T3CODE_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
      EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
      EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

it("does not read repository env files in QA sandboxes", () => {
  const env = { T3CODE_QA_SANDBOX: "qa", HOME: "/private/tmp/qa/home" };
  expect(loadRepoEnv({ baseEnv: env, repoRoot: "/missing/qa/repo" })).toEqual(env);
});

describe("selectSharedT3ConnectEnv", () => {
  const sampleEnvFile = [
    "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
    "T3CODE_CLERK_JWT_TEMPLATE=t3-relay",
    "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_cli_shared",
    "T3CODE_RELAY_URL=https://relay.example.test",
    "T3CODE_CLERK_PASSKEY_RP_DOMAINS=clerk.example.test",
    "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL=https://traces.example.test/v1/traces",
    "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET=relay-traces",
    "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN=secret-trace-token",
    "VITE_RELAY_OTLP_TRACES_URL=https://traces.example.test/v1/traces",
    "T3CODE_MOBILE_OTLP_TRACES_TOKEN=secret-mobile-token",
    "T3CODE_DEV_AUTH_TOKEN=secret-dev-token",
    "GITHUB_REPOSITORY=owner/private-repo",
    "CSC_LINK=/path/to/cert.p12",
  ].join("\n");

  it("projects only the public example's Connect keys and never mixes in a custom deployment", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env.example"), sampleEnvFile);
    const env = loadRepoEnv({ baseEnv: {}, repoRoot });
    expect(env).toMatchObject(selectSharedT3ConnectEnv(sampleEnvFile));
    expect(env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY).toBe(env.T3CODE_CLERK_PUBLISHABLE_KEY);
    expect(env.VITE_T3CODE_RELAY_URL).toBe(env.T3CODE_RELAY_URL);
    expect(env.T3CODE_DEV_AUTH_TOKEN).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(
      loadRepoEnv({ baseEnv: { T3CODE_RELAY_URL: "https://custom.test" }, repoRoot })
        .T3CODE_CLERK_PUBLISHABLE_KEY,
    ).toBeUndefined();
  });

  it("extracts only the four public T3 Connect settings and drops telemetry, passkeys, and other keys", () => {
    const selected = selectSharedT3ConnectEnv(sampleEnvFile);

    expect(Object.keys(selected).sort()).toEqual([...SHARED_T3_CONNECT_ENV_KEYS].sort());
    expect(selected).toEqual({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
      T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_cli_shared",
      T3CODE_RELAY_URL: "https://relay.example.test",
    });

    const repoEnv = loadRepoEnv({ baseEnv: selected, repoRoot: makeTemporaryDirectory() });
    expect(repoEnv).toMatchObject({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
      T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
      VITE_CLERK_JWT_TEMPLATE: "t3-relay",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_cli_shared",
      VITE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_cli_shared",
      T3CODE_RELAY_URL: "https://relay.example.test",
      VITE_T3CODE_RELAY_URL: "https://relay.example.test",
    });
    expect(repoEnv.T3CODE_CLERK_PASSKEY_RP_DOMAINS).toBeUndefined();
    expect(repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL).toBeUndefined();
    expect(repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET).toBeUndefined();
    expect(repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(repoEnv.VITE_RELAY_OTLP_TRACES_URL).toBeUndefined();
    expect(repoEnv.VITE_RELAY_OTLP_TRACES_DATASET).toBeUndefined();
    expect(repoEnv.VITE_RELAY_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(repoEnv.T3CODE_MOBILE_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(repoEnv.T3CODE_DEV_AUTH_TOKEN).toBeUndefined();
  });

  it("reports missing required key names without echoing any secret values", () => {
    expect(() =>
      selectSharedT3ConnectEnv(
        "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_secret_value\nT3CODE_RELAY_URL=https://relay.example.test\n",
      ),
    ).toThrow(/T3CODE_CLERK_JWT_TEMPLATE.*T3CODE_CLERK_CLI_OAUTH_CLIENT_ID/);
    expect(() =>
      selectSharedT3ConnectEnv("T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_secret_value\n"),
    ).not.toThrow(/pk_test_secret_value/);
  });

  it("wires the four settings into web, desktop, and server Vite defines while keeping telemetry and passkeys off", async () => {
    const selected = selectSharedT3ConnectEnv(sampleEnvFile);
    const savedEnv = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) {
        if (
          key.startsWith("T3CODE_") ||
          key.startsWith("VITE_") ||
          key.startsWith("EXPO_PUBLIC_")
        ) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, selected);
      vi.resetModules();

      const configPath = (app: string) =>
        NodePath.resolve(import.meta.dirname, `../../apps/${app}/vite.config.ts`);
      const [webModule, desktopModule, serverModule] = (await Promise.all([
        import(/* @vite-ignore */ configPath("web")),
        import(/* @vite-ignore */ configPath("desktop")),
        import(/* @vite-ignore */ configPath("server")),
      ])) as [{ default: unknown }, { default: unknown }, { default: unknown }];
      const webExport = webModule.default as
        | ((env: { command: "build"; mode: string }) => { define?: Record<string, string> })
        | { define?: Record<string, string> };
      const webConfig =
        typeof webExport === "function"
          ? webExport({ command: "build", mode: "production" })
          : webExport;
      const webDefines = webConfig.define ?? {};
      const desktopPack = (
        desktopModule.default as {
          pack?: ReadonlyArray<{ entry?: readonly string[]; define?: Record<string, string> }>;
        }
      ).pack;
      const desktopDefines =
        desktopPack?.find((entry) => entry.entry?.includes("src/main.ts"))?.define ?? {};
      const serverDefines =
        (serverModule.default as { pack?: { define?: Record<string, string> } }).pack?.define ?? {};

      expect(webDefines["import.meta.env.VITE_CLERK_PUBLISHABLE_KEY"]).toBe(
        JSON.stringify("pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA=="),
      );
      expect(webDefines["import.meta.env.VITE_CLERK_JWT_TEMPLATE"]).toBe(
        JSON.stringify("t3-relay"),
      );
      expect(webDefines["import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID"]).toBe(
        JSON.stringify("oauth_cli_shared"),
      );
      expect(webDefines["import.meta.env.VITE_T3CODE_RELAY_URL"]).toBe(
        JSON.stringify("https://relay.example.test"),
      );
      expect(webDefines["import.meta.env.VITE_RELAY_OTLP_TRACES_URL"]).toBe(JSON.stringify(""));
      expect(webDefines["import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET"]).toBe(JSON.stringify(""));
      expect(webDefines["import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN"]).toBe(JSON.stringify(""));

      expect(desktopDefines.__T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__).toBe(
        JSON.stringify("pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA=="),
      );

      expect(serverDefines.__T3CODE_BUILD_RELAY_URL__).toBe(
        JSON.stringify("https://relay.example.test"),
      );
      expect(serverDefines.__T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__).toBe(
        JSON.stringify("pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA=="),
      );
      expect(serverDefines.__T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__).toBe(
        JSON.stringify("oauth_cli_shared"),
      );
      expect(serverDefines.__T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__).toBe(JSON.stringify(""));
      expect(serverDefines.__T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__).toBe(
        JSON.stringify(""),
      );
      expect(serverDefines.__T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__).toBe(
        JSON.stringify(""),
      );
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, savedEnv);
    }
  });
});
