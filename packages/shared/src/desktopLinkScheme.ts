/**
 * The URL scheme the operating system hands to the desktop app. The Info.plist and the Linux URL
 * handler claim it, the desktop accepts prompt, thread, sign-in and return links on it, and the
 * app writes its own deep links with it. The shareable SSHCode has its own scheme, so it never
 * takes the `t3code://` links of upstream T3 Code or the personal SSHCode, and they never take its links.
 *
 * The renderer's `t3code://app` origin (apps/desktop ElectronProtocol) is a separate scheme:
 * Electron serves the web client from it, and the OS never sees it.
 */
export const DESKTOP_LINK_SCHEME = "sshcode";
export const DESKTOP_DEVELOPMENT_LINK_SCHEME = "sshcode-dev";

export const desktopLinkScheme = (development: boolean) =>
  development ? DESKTOP_DEVELOPMENT_LINK_SCHEME : DESKTOP_LINK_SCHEME;

/** Whether a URL `protocol` (`sshcode:`) belongs to either build's link scheme. */
export const isDesktopLinkProtocol = (protocol: string) =>
  protocol === `${DESKTOP_LINK_SCHEME}:` || protocol === `${DESKTOP_DEVELOPMENT_LINK_SCHEME}:`;

const LINK_SCHEME_FOR_RENDERER_PROTOCOL: Readonly<Record<string, string>> = {
  "t3code:": DESKTOP_LINK_SCHEME,
  "t3code-dev:": DESKTOP_DEVELOPMENT_LINK_SCHEME,
};

/**
 * The link that brings a browser back to a desktop renderer page: `t3code://app/settings`
 * becomes `sshcode://app/settings`. Return addresses a browser opens must use it, because the OS
 * routes the renderer's own scheme to whichever app claims it. Any other URL is unchanged.
 */
export function desktopLinkForPage(href: string): string {
  if (!URL.canParse(href)) return href;
  const url = new URL(href);
  const scheme = LINK_SCHEME_FOR_RENDERER_PROTOCOL[url.protocol];
  return scheme === undefined ? href : `${scheme}:${href.slice(url.protocol.length)}`;
}
