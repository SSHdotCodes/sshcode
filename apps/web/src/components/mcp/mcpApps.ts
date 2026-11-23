import chatgptLogo from "./logos/chatgpt.png";
import claudeLogo from "./logos/claude.png";
import grokBotLogo from "./logos/grokbot.png";
import hermesLogo from "./logos/hermes.png";
import instinctLogo from "./logos/instinct.png";
import museLogo from "./logos/muse.png";
import openClawLogo from "./logos/openclaw.png";
import pokeLogo from "./logos/poke.png";

export type McpAppHandoff =
  | { readonly kind: "open"; readonly link: (url: string) => string }
  | { readonly kind: "copy-url"; readonly link: string }
  | { readonly kind: "commands"; readonly command: (url: string) => string }
  | { readonly kind: "url" };

export interface McpApp {
  readonly id: string;
  readonly name: string;
  readonly logo?: string;
  readonly publicAddress: boolean;
  /** Confirmed callback hostnames only; ports are ignored when checking a sign-in. */
  readonly expectedDestinations?: readonly string[];
  readonly instruction: string;
  readonly handoff: McpAppHandoff;
}

const encoded = encodeURIComponent;
export const shellQuoteMcpUrl = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

// Local CLI callbacks use loopback with a port chosen for each sign-in.
// https://code.claude.com/docs/en/mcp#use-a-fixed-oauth-callback-port
// https://learn.chatgpt.com/docs/extend/mcp#oauth-client-registration
const LOOPBACK_DESTINATIONS = ["localhost", "127.0.0.1", "[::1]"] as const;

export const MCP_APPS: readonly McpApp[] = [
  {
    id: "poke",
    name: "Poke",
    logo: pokeLogo,
    publicAddress: true,
    instruction: "Add this URL as a Poke integration, then allow it here.",
    handoff: {
      kind: "open",
      link: (url) => `https://poke.com/integrations/new?name=SSHCode&url=${encoded(url)}`,
    },
  },
  {
    id: "claude",
    name: "Claude",
    logo: claudeLogo,
    publicAddress: true,
    // https://claude.com/docs/connectors/building/authentication#callback-urls
    expectedDestinations: ["claude.ai"],
    instruction: "Add SSHCode as a custom connector, then allow it here.",
    handoff: {
      kind: "open",
      link: (url) =>
        `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=SSHCode&connectorUrl=${encoded(url)}`,
    },
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    logo: chatgptLogo,
    publicAddress: true,
    // https://developers.openai.com/plugins/build/auth#redirect-url
    expectedDestinations: ["chatgpt.com"],
    instruction: "Add a custom MCP server with OAuth, then allow it here.",
    handoff: { kind: "copy-url", link: "https://chatgpt.com/plugins" },
  },
  {
    id: "grok-bot",
    name: "Grok Bot",
    logo: grokBotLogo,
    publicAddress: true,
    instruction: "Ask your Grok Bot to connect this URL, then allow it here.",
    handoff: { kind: "copy-url", link: "https://x.ai/bot" },
  },
  {
    id: "muse",
    name: "Muse",
    logo: museLogo,
    publicAddress: true,
    instruction: "Ask Muse to connect this URL, then allow it here.",
    handoff: { kind: "copy-url", link: "https://muse.ai" },
  },
  {
    id: "instinct",
    name: "Instinct",
    logo: instinctLogo,
    publicAddress: true,
    instruction: "Add this URL in Instinct’s MCP connections, then allow it here.",
    handoff: { kind: "copy-url", link: "https://app.instinct.com" },
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    logo: openClawLogo,
    publicAddress: false,
    instruction: "Run this where OpenClaw runs, then allow the sign-in here.",
    handoff: {
      kind: "commands",
      command: (url) =>
        `openclaw gateway stop && openclaw mcp add sshcode --url ${shellQuoteMcpUrl(url)} --transport streamable-http --auth oauth && openclaw mcp login sshcode && openclaw gateway start`,
    },
  },
  {
    id: "hermes-agent",
    name: "Hermes Agent",
    logo: hermesLogo,
    publicAddress: false,
    instruction: "Run this where Hermes runs, then allow the sign-in here.",
    handoff: {
      kind: "commands",
      command: (url) =>
        `hermes mcp add sshcode --url ${shellQuoteMcpUrl(url)} --auth oauth --connect-timeout 315`,
    },
  },
];

export const OTHER_MCP_APPS: readonly McpApp[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    logo: claudeLogo,
    publicAddress: false,
    expectedDestinations: LOOPBACK_DESTINATIONS,
    instruction: "Paste this command in Terminal, then allow the sign-in here.",
    handoff: {
      kind: "commands",
      command: (url) =>
        `claude mcp add --transport http sshcode ${shellQuoteMcpUrl(url)} && claude mcp login sshcode`,
    },
  },
  {
    id: "codex",
    name: "Codex",
    logo: chatgptLogo,
    publicAddress: false,
    expectedDestinations: LOOPBACK_DESTINATIONS,
    instruction: "Paste this command in Terminal, then allow the sign-in here.",
    handoff: {
      kind: "commands",
      // Codex's add command starts OAuth itself; another login would ask twice.
      command: (url) => `codex mcp add sshcode --url ${shellQuoteMcpUrl(url)}`,
    },
  },
  {
    id: "other",
    name: "your app",
    publicAddress: false,
    instruction: "Add this URL as a remote MCP server with OAuth, then allow it here.",
    handoff: { kind: "url" },
  },
];

/** The server supplies URL.host. Strip its port, then compare the whole hostname. */
export function mcpDestinationMismatch(app: McpApp, destination: string): boolean {
  if (app.expectedDestinations === undefined) return false;
  const hostname = destination.replace(/:\d+$/, "").toLowerCase();
  return !app.expectedDestinations.includes(hostname);
}

/** One copy action per paste; hosted apps that need it copy the URL and open their add page. */
export function mcpHandoffAction(app: McpApp, mcpUrl: string) {
  switch (app.handoff.kind) {
    case "open":
      return { label: `Open in ${app.name}`, link: app.handoff.link(mcpUrl), copy: null };
    case "copy-url":
      return {
        label: `Copy URL and open ${app.name}`,
        link: app.handoff.link,
        copy: { text: mcpUrl, title: "URL copied" },
      };
    case "commands":
    case "url":
      return null;
  }
}
