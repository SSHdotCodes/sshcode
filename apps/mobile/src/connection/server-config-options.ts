/**
 * Shared `subscribeServerConfig` flags passed to both `Connection.layerWithOptions`
 * and `createServerEnvironmentAtoms`. Keeping them identical lets `RpcSession`
 * reuse its single held-catalog config subscription instead of opening a second
 * full-catalog stream on every connect and reconnect.
 */
export const MOBILE_SERVER_CONFIG_SUBSCRIPTION_OPTIONS = {
  chatTabs: true,
  usageLimitSources: true,
  usageLimitsCommand: true,
  compactProviders: true,
} as const;
