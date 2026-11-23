import { isLoopbackHostname } from "~/environments/primary";
import { buildHostedPairingUrl } from "../../hostedPairing";
import { setPairingTokenOnUrl } from "../../pairingUrl";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}

export function resolveCurrentOriginPairingUrl(
  credential: string,
  currentHref: string = window.location.href,
): string | null {
  const url = new URL("/pair", currentHref);
  // The packaged desktop window loads from t3code://app, which no other device can open.
  if ((url.protocol !== "http:" && url.protocol !== "https:") || isLoopbackHostname(url.hostname)) {
    return null;
  }
  return setPairingTokenOnUrl(url, credential).toString();
}
