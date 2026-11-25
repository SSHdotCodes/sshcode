/**
 * Groups a catalog spread over many harnesses by who made each model, so a
 * model reached through several harnesses or gateways shows once, with its
 * routes listed apart. Pure: web and mobile pickers share it.
 *
 * Everything is derived from the live catalog. Makers come from the model
 * family (`modelRankingFamily`); the only fixed knowledge is family-level:
 * maker names and icons, and which harness each family runs best in.
 */
import { officialAcpRegistryIconUrlForAgentId } from "@t3tools/contracts";
import { modelRankingFamily } from "@t3tools/shared/modelRankings";

/** One model as one provider instance lists it. */
export interface ModelRouteSource {
  readonly instanceId: string;
  readonly driver: string;
  /** The instance's display name, such as "Hermes · Open models". */
  readonly instanceName: string;
  readonly slug: string;
  readonly name: string;
  readonly subProvider?: string | undefined;
  readonly family?: string | undefined;
  readonly isLegacy?: boolean | undefined;
}

/** A maker's own one-colour mark, for a maker no harness icon stands for. */
export interface ModelMakerLogo {
  readonly viewBox: string;
  readonly path: string;
  readonly evenOdd?: boolean;
}

export interface ModelMaker {
  readonly id: string;
  readonly label: string;
  /** Other names people search by: the company behind the brand ("Alibaba" for Qwen). */
  readonly aliases?: ReadonlyArray<string>;
  /** A harness whose icon stands for the maker; null draws `logo`, else `monogram`. */
  readonly icon: { readonly driver: string; readonly acpAgentId?: string } | null;
  readonly logo?: ModelMakerLogo;
  readonly monogram: string;
}

/**
 * Gemini's sparkle in its own colours, which Antigravity (Google's agent) wears
 * as Claude Code wears Claude's mark.
 */
export const GEMINI_SPARK = {
  viewBox: "0 0 28 28",
  path: "M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z",
  // Google's radial gradient: purple at the left point, blue to the right.
  gradientTransform: "translate(2.77876 11.3795) rotate(18.6832) scale(29.8025 238.737)",
  stops: [
    { offset: 0.0671246, color: "#9168C0" },
    { offset: 0.342551, color: "#5684D1" },
    { offset: 0.672076, color: "#1BA1E3" },
  ],
} as const;

/**
 * Devin's mark (Cognition): three linked hexagons in Devin's own blue, green and sky,
 * as LobeHub's icon set draws it (MIT). Devin and the SWE models wear it.
 */
export const DEVIN_MARK = {
  viewBox: "0 0 24 24",
  paths: [
    {
      d: "M2.033 9.867l2.554 1.483a.589.589 0 00.592 0l2.554-1.483.01-.008a.608.608 0 00.11-.084l.013-.015a.631.631 0 00.076-.1c.003-.005.008-.01.01-.016a.558.558 0 00.052-.125l.007-.028a.611.611 0 00.019-.14V7.868c0-.572.307-1.105.8-1.392a1.595 1.595 0 011.598 0l1.277.742a.54.54 0 00.129.053l.028.01c.044.01.088.015.133.016h.006l.013-.002a.587.587 0 00.27-.074l.011-.004 2.554-1.483a.596.596 0 00.297-.516V2.253a.595.595 0 00-.297-.516L12.293.257a.587.587 0 00-.591 0L9.148 1.737l-.01.01a.609.609 0 00-.109.083l-.014.015a.632.632 0 00-.076.1c-.003.005-.008.01-.01.016a.57.57 0 00-.052.124l-.007.028a.612.612 0 00-.018.14v1.483c0 .572-.307 1.105-.8 1.393a1.597 1.597 0 01-1.599 0l-1.276-.742a.603.603 0 00-.13-.053l-.028-.008a.658.658 0 00-.133-.018h-.02a.57.57 0 00-.269.074c-.003.002-.008.002-.012.005L2.033 5.872a.596.596 0 00-.297.515v2.966c0 .213.113.41.297.515z",
      fill: "#3969CA",
    },
    {
      d: "M15.943 10.607a1.596 1.596 0 011.599 0l1.276.74c.041.025.085.04.13.055l.028.008c.043.01.088.016.133.018h.005c.005 0 .01-.002.014-.003a.474.474 0 00.122-.016l.021-.005a.616.616 0 00.126-.052c.004-.002.009-.002.013-.005l2.554-1.482a.597.597 0 00.297-.516V6.383a.596.596 0 00-.297-.515l-2.552-1.483a.587.587 0 00-.592 0l-2.553 1.482-.011.008a.61.61 0 00-.108.084l-.014.016a.637.637 0 00-.076.1c-.003.005-.008.01-.01.016a.57.57 0 00-.052.124l-.007.029a.612.612 0 00-.018.14v1.482c0 .572-.307 1.105-.8 1.393a1.597 1.597 0 01-1.599 0l-1.276-.742a.584.584 0 00-.13-.053l-.028-.008a.62.62 0 00-.133-.018h-.02a.587.587 0 00-.269.074l-.012.004L9.15 10a.596.596 0 00-.296.516v2.966c0 .212.112.409.296.515l2.554 1.483s.008.002.012.005c.04.022.082.04.126.052l.02.004a.57.57 0 00.123.017l.014.002h.006c.054 0 .108-.01.16-.025a.587.587 0 00.13-.054l1.277-.741a1.597 1.597 0 012.398 1.392v1.482c0 .049.007.095.019.14l.007.028a.619.619 0 00.051.125c.004.006.008.01.01.016a.6.6 0 00.076.1l.014.015c.033.032.069.06.108.084.004.002.006.006.011.008l2.554 1.483a.59.59 0 00.593 0l2.554-1.483a.597.597 0 00.296-.516v-2.965a.595.595 0 00-.296-.516l-2.554-1.483s-.008-.002-.012-.005a.54.54 0 00-.126-.051c-.007-.003-.013-.003-.02-.005a.635.635 0 00-.125-.017h-.018a.557.557 0 00-.16.026.588.588 0 00-.13.053l-1.276.742a1.595 1.595 0 01-1.598 0 1.615 1.615 0 010-2.785l-.005-.001z",
      fill: "#21C19A",
    },
    {
      d: "M14.848 18.265l-2.554-1.482-.012-.005a.526.526 0 00-.126-.052c-.007-.002-.014-.002-.02-.005a.64.64 0 00-.124-.017h-.02a.56.56 0 00-.16.026.588.588 0 00-.13.053l-1.276.742a1.594 1.594 0 01-1.598 0c-.493-.286-.8-.82-.8-1.393V14.65a.563.563 0 00-.018-.14l-.008-.028a.604.604 0 00-.051-.124l-.01-.017a.603.603 0 00-.076-.1l-.014-.015a.596.596 0 00-.109-.084c-.003-.002-.005-.006-.01-.008L5.178 12.65a.587.587 0 00-.591 0l-2.554 1.483a.596.596 0 00-.297.516v2.965c0 .213.113.41.297.516l2.554 1.483.012.004a.618.618 0 00.267.074l.016.002h.007a.55.55 0 00.16-.026.584.584 0 00.129-.053l1.277-.742a1.597 1.597 0 012.398 1.393v1.482c0 .05.007.095.019.14l.007.028c.013.044.03.085.051.125l.01.016c.022.036.047.07.076.1l.014.015c.032.032.069.06.109.084l.01.008 2.554 1.483a.587.587 0 00.593 0l2.554-1.483a.596.596 0 00.296-.515v-2.966a.596.596 0 00-.296-.516h-.002z",
      fill: "#0294DE",
    },
  ],
} as const;

/** Devin's ACP registry id; its registry glyph is replaced by `DEVIN_MARK` wherever it shows. */
export const DEVIN_ACP_AGENT_ID = "devin";
const DEVIN_REGISTRY_ICON_URL = officialAcpRegistryIconUrlForAgentId(DEVIN_ACP_AGENT_ID);

/** Whether a registry icon URL is Devin's, which draws as `DEVIN_MARK` in its own colours. */
export function isDevinRegistryIcon(iconUrl: string | null | undefined): boolean {
  return iconUrl != null && iconUrl === DEVIN_REGISTRY_ICON_URL;
}

/** DeepSeek's whale (its logo, as LobeHub's icon set draws it in one colour). */
const DEEPSEEK_LOGO: ModelMakerLogo = {
  viewBox: "0 0 24 24",
  path: "M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z",
  evenOdd: true,
};
/**
 * Thinking Machines' logo is its stacked "THINKING MACHINES" wordmark, unreadable at icon
 * size, so its initials are drawn in the wordmark's square-cut capitals.
 */
const THINKING_MACHINES_LOGO: ModelMakerLogo = {
  viewBox: "0 0 24 24",
  path: "M.5 4h10v2.6H6.8V20H4.2V6.6H.5ZM12 20V4h2.7l3.05 7.2L20.8 4h2.7v16H21V9.6l-3.25 7.3-3.25-7.3V20Z",
};
/** MiniMax's waveform, as LobeHub's icon set draws it in one colour. */
const MINIMAX_LOGO: ModelMakerLogo = {
  viewBox: "0 0 24 24",
  path: "M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z",
  evenOdd: true,
};

/** One way to run a model: an instance, plus every slug it lists the model under. */
export interface ModelRoute<T extends ModelRouteSource> {
  readonly key: string;
  /** The slug a pick selects; effort-suffixed siblings are in `sources`. */
  readonly source: T;
  readonly sources: ReadonlyArray<T>;
  /** "Hermes · OpenRouter", "Claude Code". */
  readonly label: string;
}

export interface MakerModel<T extends ModelRouteSource> {
  /** Stable across routes: the maker and the model's normalized id. */
  readonly key: string;
  readonly makerId: string;
  readonly family: string;
  readonly name: string;
  readonly isLegacy: boolean;
  readonly routes: ReadonlyArray<ModelRoute<T>>;
}

export interface MakerGroup<T extends ModelRouteSource> {
  readonly maker: ModelMaker;
  readonly models: ReadonlyArray<MakerModel<T>>;
}

export const OTHER_MAKER_ID = "other";

/** Family → maker. Families not listed here are grouped under Other. */
const MAKERS: ReadonlyArray<ModelMaker & { readonly families: ReadonlyArray<string> }> = [
  { id: "openai", label: "OpenAI", families: ["codex"], icon: { driver: "codex" }, monogram: "O" },
  {
    id: "anthropic",
    label: "Anthropic",
    families: ["claude"],
    icon: { driver: "claudeAgent" },
    monogram: "A",
  },
  { id: "xai", label: "xAI", families: ["grok"], icon: { driver: "grok" }, monogram: "x" },
  {
    id: "google",
    label: "Google",
    families: ["gemini"],
    icon: { driver: "acpRegistry", acpAgentId: "gemini" },
    monogram: "G",
  },
  {
    id: "qwen",
    label: "Qwen",
    aliases: ["Alibaba"],
    families: ["qwen"],
    icon: { driver: "acpRegistry", acpAgentId: "qwen-code" },
    monogram: "Q",
  },
  {
    id: "moonshot",
    label: "Kimi",
    aliases: ["Moonshot"],
    families: ["kimi"],
    icon: { driver: "acpRegistry", acpAgentId: "kimi" },
    monogram: "K",
  },
  {
    id: "zai",
    label: "Z.ai",
    aliases: ["Zhipu"],
    families: ["glm"],
    icon: { driver: "acpRegistry", acpAgentId: "glm-acp-agent" },
    monogram: "Z",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    families: ["deepseek"],
    icon: null,
    logo: DEEPSEEK_LOGO,
    monogram: "DS",
  },
  {
    id: "mistral",
    label: "Mistral",
    families: ["mistral"],
    icon: { driver: "acpRegistry", acpAgentId: "mistral-vibe" },
    monogram: "M",
  },
  {
    id: "recursive",
    label: "Flint",
    aliases: ["Recursive"],
    families: ["flint"],
    icon: null,
    monogram: "F",
  },
  {
    id: "minimax",
    label: "MiniMax",
    families: ["minimax"],
    icon: null,
    logo: MINIMAX_LOGO,
    monogram: "MM",
  },
  {
    id: "thinkingmachines",
    label: "Thinking Machines",
    families: ["inkling"],
    icon: null,
    logo: THINKING_MACHINES_LOGO,
    monogram: "TM",
  },
  {
    id: "cursor",
    label: "Cursor",
    families: ["composer"],
    icon: { driver: "cursor" },
    monogram: "C",
  },
  // Meta's models: Muse, and the older Llama line that only gateways still list.
  {
    id: "muse",
    label: "Meta",
    families: ["muse", "llama"],
    icon: { driver: "muse" },
    monogram: "M",
  },
  // Cognition's SWE models (SWE-2, SWE-2 Flash), run in Devin.
  {
    id: "cognition",
    label: "Cognition",
    aliases: ["Devin", "Windsurf"],
    families: ["swe"],
    icon: { driver: "acpRegistry", acpAgentId: DEVIN_ACP_AGENT_ID },
    monogram: "D",
  },
  // Tencent's Hy line (Hunyuan). Not in the curated list: search finds it.
  {
    id: "tencent",
    label: "Tencent",
    aliases: ["Hunyuan"],
    families: ["hy"],
    icon: null,
    monogram: "T",
  },
];
/** Where a family stands among its maker's lines: the first listed is the main one. */
function familyRank(makerId: string, family: string): number {
  const index = MAKERS.find((maker) => maker.id === makerId)?.families.indexOf(family) ?? -1;
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

const OTHER_MAKER: ModelMaker = { id: OTHER_MAKER_ID, label: "Other", icon: null, monogram: "…" };
const MAKER_BY_FAMILY = new Map(
  MAKERS.flatMap(({ families, ...maker }) => families.map((family) => [family, maker] as const)),
);

/** Families `modelRankingFamily` doesn't know, by a word in the model's id or name. */
const EXTRA_FAMILIES: ReadonlyArray<readonly [string, RegExp]> = [
  ["flint", /(?:^|[^a-z])(?:flint|recursive)(?:[^a-z]|$)/],
  ["inkling", /(?:^|[^a-z])(?:inkling|thinkingmachines|thinking-machines)(?:[^a-z]|$)/],
  // `hy4-flash`, `hy3-preview`, `hunyuan-a13b`; the Hy-MT translation models stay under Other.
  ["hy", /(?:^|[^a-z])(?:hy\d+|hunyuan)(?:[^a-z0-9]|$)/],
  // `swe-2`, `swe-2-flash`, `SWE-1.5`.
  ["swe", /(?:^|[^a-z])swe-?\d/],
  // NVIDIA's Nemotron has no maker here: Other, never the harness that lists it.
  ["nemotron", /(?:^|[^a-z])nemotron(?:[^a-z]|$)/],
];

/** The token a family's ids start with once org prefixes are gone (`zai-glm-5` → `glm-5`). */
const FAMILY_ID_TOKEN: Readonly<Record<string, string>> = { codex: "gpt" };

/** Which harness each family runs best in, best first (Harness Leaderboard, Nov 2026). */
const PREFERRED_HARNESSES: Readonly<Record<string, ReadonlyArray<string>>> = {
  glm: ["pi", "kimi", "hermes"],
  deepseek: ["hermes", "pi"],
  flint: ["kimi", "hermes", "pi"],
  claude: ["claude"],
  codex: ["codex"],
  qwen: ["qwen"],
  kimi: ["kimi"],
  grok: ["grok"],
  mistral: ["mistral"],
  muse: ["muse"],
  // Google's own agent, on the Google AI plan.
  gemini: ["antigravity"],
  swe: ["devin"],
};

const isDevinRoute = (source: ModelRouteSource) =>
  source.driver === "acpRegistry" && /\bdevin\b/i.test(source.instanceName);

const HARNESS_MATCHERS: Readonly<Record<string, (route: ModelRouteSource) => boolean>> = {
  pi: (route) => route.driver === "pi",
  codex: (route) => route.driver === "codex",
  claude: (route) => route.driver === "claudeAgent",
  grok: (route) => route.driver === "grok",
  hermes: (route) => /\bhermes\b/i.test(route.instanceName),
  kimi: (route) => route.driver === "acpRegistry" && /\bkimi\b/i.test(route.instanceName),
  qwen: (route) => /\bqwen code\b/i.test(route.instanceName),
  mistral: (route) => /\bmistral vibe\b/i.test(route.instanceName),
  muse: (route) => route.driver === "muse",
  antigravity: (route) => route.driver === "antigravity",
  devin: isDevinRoute,
};

const vendorOf = (family: string) => family.split(":")[0]!;

/** The provider a route's account belongs to; each ACP registry agent is its own. */
const providerKeyOf = (source: ModelRouteSource) =>
  source.driver === "acpRegistry" ? source.instanceId : source.driver;

/** No provider fallback: only what the text itself says. */
const textFamily = (text: string) => {
  const family = modelRankingFamily({ slug: text }, { driver: "" });
  if (!family.startsWith("provider:")) return vendorOf(family);
  const lower = text.toLowerCase();
  return EXTRA_FAMILIES.find(([, pattern]) => pattern.test(lower))?.[0] ?? null;
};

/**
 * A harness's own default model, which names no model; it stays one row per instance.
 * Devin's is "Adaptive", its router, filed under Cognition.
 */
const isHarnessDefault = (source: ModelRouteSource) => {
  const slug = source.slug.toLowerCase();
  return slug === "default" || (slug === "adaptive" && isDevinRoute(source));
};

/**
 * The model's vendor family (`claude`, `glm`, `flint`, …), or null. Read from
 * the model before the harness, so Kimi Code serving GLM files GLM under Z.ai.
 */
export function modelVendorFamily(source: ModelRouteSource): string | null {
  // Devin's Fusion pairs a lead model with a sidekick (`fusion-claude-…-sidekick-swe-2-…`):
  // Devin's own way of running, filed under Cognition, not under the lead's maker.
  if (/^fusion\b/i.test(source.name.trim()) || /(?:^|[/:])fusion-/i.test(source.slug)) {
    return "swe";
  }
  if (source.family) {
    const family = vendorOf(source.family);
    if (!family.startsWith("provider")) return family;
  }
  // The model wins over its publisher namespace (meta-llama/muse-spark is Muse).
  const fromModel =
    textFamily(source.slug.split("/").at(-1)!) ??
    textFamily(`${source.subProvider ?? ""}/${source.slug}`) ??
    textFamily(source.name);
  if (fromModel !== null) return fromModel;
  // A registry agent's name says whose models it runs ("Kimi (API key)" → Kimi), and a
  // harness default runs its own. Claude Code, OpenCode and Pi run anything.
  if (isHarnessDefault(source) && isDevinRoute(source)) return "swe";
  return source.driver === "acpRegistry" || isHarnessDefault(source)
    ? textFamily(source.instanceName)
    : null;
}

export function modelMakerForFamily(family: string | null): ModelMaker {
  return (family === null ? undefined : MAKER_BY_FAMILY.get(family)) ?? OTHER_MAKER;
}

/** Every name a search may call the maker by ("Tencent Hunyuan"); empty for Other. */
export function modelMakerSearchNames(maker: ModelMaker): string {
  return maker.id === OTHER_MAKER_ID ? "" : [maker.label, ...(maker.aliases ?? [])].join(" ");
}

/** Gateway tags OpenRouter appends to an id (`flint-v1.0:free`). */
const VARIANT_TAGS = new Set(["free", "beta", "extended", "thinking", "online", "nitro", "floor"]);
/** Suffixes that pick an effort or a helper of a model the same instance also lists. */
const EFFORT_SUFFIX = /-(?:none|minimal|low|medium|high|xhigh|max|title|off)$/;

/** The model part of a route-specific slug: no gateway, org, tags or punctuation. */
function bareModelId(slug: string): string {
  let id = slug.trim();
  if (id.startsWith("[")) {
    try {
      const parts: unknown = JSON.parse(id);
      if (Array.isArray(parts) && typeof parts.at(-1) === "string") id = parts.at(-1) as string;
    } catch {
      // Not a JSON id; read it as written.
    }
  }
  id = id.toLowerCase().replace(/\([^)]*\)\s*$/, "");
  const last = id.split("/").at(-1)!;
  const tags = last.split(":");
  while (tags.length > 1 && VARIANT_TAGS.has(tags.at(-1)!)) tags.pop();
  return tags
    .at(-1)!
    .replace(/[._\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Drops org tokens before the family's own (`zai-glm-5-3-flash` → `glm-5-3-flash`). */
function withoutOrgPrefix(id: string, family: string | null): string {
  if (family === null) return id;
  const token = FAMILY_ID_TOKEN[family] ?? family;
  const tokens = id.split("-");
  const start = tokens.findIndex((part) => part.startsWith(token));
  return start > 0 ? tokens.slice(start).join("-") : id;
}

/**
 * The id a model has on every route. Aliases with no version ("opus" listed
 * as "k3.1-pro") take the version their name gives.
 */
export function canonicalModelId(source: ModelRouteSource, family: string | null): string {
  const fromSlug = withoutOrgPrefix(bareModelId(source.slug), family);
  if (/\d/.test(fromSlug)) return fromSlug;
  const fromName = withoutOrgPrefix(bareModelId(source.name), family);
  return /\d/.test(fromName) && !/\s/.test(source.name.trim()) ? fromName : fromSlug;
}

const GATEWAY_LABELS: Readonly<Record<string, string>> = {
  openrouter: "OpenRouter",
  "opencode-go": "OpenCode Go",
  opencode: "OpenCode Zen",
  zen: "OpenCode Zen",
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  deepinfra: "DeepInfra",
  together: "Together",
  fireworks: "Fireworks",
  groq: "Groq",
  huggingface: "Hugging Face",
  "github-copilot": "GitHub Copilot",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

const titleCase = (value: string) =>
  value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`)
    .join(" ");

/** The gateway a slug routes through (`custom:openrouter:z-ai/glm` → OpenRouter), if it says. */
function slugGateway(source: ModelRouteSource): string | null {
  if (source.subProvider) return source.subProvider;
  const slug = source.slug.trim();
  if (slug.startsWith("[")) return null;
  const segments = slug.split("/");
  const prefixes = segments[0]!.split(":").filter((part) => part !== "custom");
  if (segments.length === 1) {
    // `anthropic:claude-opus-5-5`: everything before the id.
    const gateway = prefixes.length > 1 ? prefixes.at(-2)! : null;
    return gateway === null ? null : (GATEWAY_LABELS[gateway] ?? titleCase(gateway));
  }
  if (prefixes.length > 1 || segments.length > 2) {
    // `custom:openrouter:z-ai/…` or `openrouter/z-ai/…`: the first name is the gateway.
    const gateway = prefixes.length > 1 ? prefixes[0]! : segments[0]!;
    return GATEWAY_LABELS[gateway] ?? titleCase(gateway);
  }
  // `org/model`: a gateway only when it is a known one, not a model org like `z-ai`.
  return GATEWAY_LABELS[segments[0]!.toLowerCase()] ?? null;
}

const sameWords = (left: string, right: string) =>
  left.toLowerCase().replace(/[^a-z0-9]/g, "") === right.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * "Harness · gateway" for one route. Instance names mix the two with a model
 * name ("Qwen4 · Claude Code", "Pi · Open models"); the model
 * name is dropped and a gateway the slug names wins over a vague one.
 */
export function modelRouteLabel(source: ModelRouteSource, modelName: string): string {
  let parts = source.instanceName
    .split(/\s+·\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const modelWord = modelName.trim().split(/[\s(]/)[0] ?? "";
  if (parts.length > 1) {
    const withoutModel = parts.filter((part) => !sameWords(part, modelWord));
    if (withoutModel.length > 0) parts = withoutModel;
  }
  if (source.driver === "claudeAgent" && parts.length === 1 && parts[0] === "Claude") {
    parts = ["Claude Code"];
  }
  const gateway = slugGateway(source);
  if (gateway === null || parts.length === 0) return parts.join(" · ") || source.instanceName;
  const harness = parts[0]!;
  // OpenCode's "OpenCode Zen" already says both.
  if (gateway.toLowerCase().startsWith(`${harness.toLowerCase()} `)) return gateway;
  if (sameWords(harness, gateway) || harness.toLowerCase().includes(gateway.toLowerCase())) {
    return parts.length > 1 ? parts.join(" · ") : harness;
  }
  if (parts.length > 1 && sameWords(parts[1]!, gateway)) return parts.join(" · ");
  return `${harness} · ${gateway}`;
}

const GATEWAY_NAMES = new Set(Object.values(GATEWAY_LABELS).map((label) => label.toLowerCase()));

/** A name a person would read: no ids, no route notes in parentheses. */
function readableName(source: ModelRouteSource): { readonly text: string; readonly score: number } {
  const full = source.name.trim();
  // A Fusion pairing is named by its brackets: "Fusion (Claude Opus 5.5 + SWE-2)", with the
  // pair's effort settings dropped.
  const fusion = /^fusion\s*\((.+)\)$/i.exec(full);
  if (fusion) {
    const pair = fusion[1]!.replace(
      /\s+(?:minimal|low|medium|high|xhigh|max)(?:\s+thinking)?(?=\s*(?:\+|$))/gi,
      "",
    );
    return { text: `Fusion (${pair.trim()})`, score: 0 };
  }
  // Antigravity names an orchestrator by the model that runs it: "Orchestrator (Neon)" reads
  // "Neon Orchestrator", where dropping the brackets left three identical "Orchestrator" rows.
  const orchestrator = /^orchestrator\s*\(([^)]+)\)$/i.exec(full);
  if (orchestrator) return { text: `${orchestrator[1]!.trim()} Orchestrator`, score: 0 };
  const bare =
    full
      .replace(/\s+[—–]\s+.*$/, "")
      .replace(/(?:\s*\([^)]*\))+\s*$/, "")
      .trim() || full;
  // "Anthropic · claude-opus-5-5" and "GLM-5.3-Flash · OpenRouter": the part the
  // slug names, else the part that isn't a gateway, never the gateway itself.
  const parts = bare
    .split(/\s+·\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const qualified = parts.length > 1;
  const slugTail = source.slug.split(/[/:]/).at(-1) ?? "";
  const text = qualified
    ? (parts.find((part) => sameWords(part, slugTail)) ??
      [...parts].reverse().find((part) => !GATEWAY_NAMES.has(part.toLowerCase())) ??
      parts.at(-1)!)
    : bare;
  const idLike = text.includes("/") || text.includes(":") || !/[A-Z\s]/.test(text);
  return {
    text,
    score: (idLike ? 4 : 0) + (qualified ? 2 : 0) + (bare !== full ? 1 : 0),
  };
}

function bestName(sources: ReadonlyArray<ModelRouteSource>): string {
  let best: { readonly text: string; readonly score: number } | null = null;
  for (const source of sources) {
    const candidate = readableName(source);
    if (
      best === null ||
      candidate.score < best.score ||
      (candidate.score === best.score && candidate.text.length < best.text.length)
    ) {
      best = candidate;
    }
  }
  return best?.text ?? "";
}

/**
 * Two accounts of one harness that offer the same model are a choice of plan,
 * not of harness. Beside an added account named "Work-2", the provider's own
 * account reads "Ultra": its harness name ("Claude Code") would look like a
 * different product. The own account takes the added one's name without its
 * number; an added account named without a number says nothing about the own
 * one, which then keeps its harness name.
 */
function nameAccountsAsPlans<T extends ModelRouteSource>(routes: Array<ModelRoute<T>>): void {
  for (const added of routes) {
    const plan = /^(.*\S)[\s_-]+\d{1,2}$/u.exec(added.source.instanceName.trim())?.[1];
    if (!plan) continue;
    const index = routes.findIndex(
      (candidate) =>
        candidate !== added &&
        candidate.source.driver === added.source.driver &&
        candidate.source.slug === added.source.slug &&
        !/[\s_-]\d{1,2}$/u.test(candidate.source.instanceName.trim()),
    );
    if (index !== -1) routes[index] = { ...routes[index]!, label: plan };
  }
}

/**
 * The catalog by maker, makers in a fixed order with Other last. A maker's models follow its own harness's order (Codex for GPT), then first
 * appearance; legacy models go last.
 */
export function groupModelsByMaker<T extends ModelRouteSource>(
  sources: ReadonlyArray<T>,
): ReadonlyArray<MakerGroup<T>> {
  // Effort-suffixed slugs fold into their base only when the instance lists the base.
  const slugsByInstance = new Map<string, Set<string>>();
  for (const source of sources) {
    const slugs = slugsByInstance.get(source.instanceId) ?? new Set<string>();
    slugs.add(source.slug.toLowerCase());
    slugsByInstance.set(source.instanceId, slugs);
  }
  const baseSlug = (source: T) => {
    const slug = source.slug.toLowerCase();
    const base = slug.replace(EFFORT_SUFFIX, "");
    if (base === slug || slugsByInstance.get(source.instanceId)!.has(base)) return base;
    // An effort the model's name never mentions is the route's reasoning setting, not part of
    // the model: Devin lists `claude-opus-5-5-medium` as "Claude Opus 5.5". "Qwen3 Max" keeps
    // its "-max".
    const effort = slug.slice(base.length + 1);
    return new RegExp(`(?:^|[^a-z])${effort}(?:[^a-z]|$)`, "i").test(source.name) ? slug : base;
  };

  type Draft = {
    key: string;
    makerId: string;
    family: string;
    order: number;
    ownOrder: number;
    sources: Array<T>;
    routes: Map<string, Array<T>>;
  };
  const drafts = new Map<string, Draft>();
  sources.forEach((source, index) => {
    const family = modelVendorFamily(source);
    const maker = modelMakerForFamily(family);
    const key = isHarnessDefault(source)
      ? `${maker.id}:${source.instanceId}:default`
      : `${maker.id}:${canonicalModelId({ ...source, slug: baseSlug(source) }, family)}`;
    let draft = drafts.get(key);
    if (draft === undefined) {
      draft = {
        key,
        makerId: maker.id,
        family: family ?? OTHER_MAKER_ID,
        order: index,
        ownOrder: Number.POSITIVE_INFINITY,
        sources: [],
        routes: new Map(),
      };
      drafts.set(key, draft);
    }
    draft.sources.push(source);
    const own = PREFERRED_HARNESSES[draft.family]?.[0];
    if (own !== undefined && HARNESS_MATCHERS[own]?.(source)) {
      draft.ownOrder = Math.min(draft.ownOrder, index);
    }
    const routeKey = `${source.instanceId}\u0000${baseSlug(source)}`;
    const route = draft.routes.get(routeKey) ?? [];
    route.push(source);
    draft.routes.set(routeKey, route);
  });

  // A gateway's unversioned alias (`meta/muse-ember`) is the line's one release when the
  // catalog lists exactly one (`muse-ember-1.0`). With several releases it stays its own row.
  for (const [key, draft] of [...drafts]) {
    if (key.endsWith(":default")) continue;
    const id = key.slice(draft.makerId.length + 1);
    if (id === "" || /\d/.test(id)) continue;
    const releases = [...drafts.values()].filter((other) => {
      if (other === draft || other.makerId !== draft.makerId || other.family !== draft.family) {
        return false;
      }
      const otherId = other.key.slice(other.makerId.length + 1);
      return otherId.startsWith(`${id}-`) && /^\d+(?:-\d+)*$/.test(otherId.slice(id.length + 1));
    });
    if (releases.length !== 1) continue;
    const release = releases[0]!;
    release.sources.push(...draft.sources);
    for (const [routeKey, routeSources] of draft.routes) {
      release.routes.set(routeKey, [...(release.routes.get(routeKey) ?? []), ...routeSources]);
    }
    release.order = Math.min(release.order, draft.order);
    release.ownOrder = Math.min(release.ownOrder, draft.ownOrder);
    drafts.delete(key);
  }

  const models = [...drafts.values()].map((draft): MakerModel<T> => {
    const name = draft.key.endsWith(":default")
      ? draft.sources[0]!.slug.toLowerCase() === "default"
        ? `${draft.sources[0]!.instanceName} default`
        : draft.sources[0]!.name
      : bestName(draft.sources);
    const seenLabels = new Set<string>();
    const routes: Array<ModelRoute<T>> = [];
    for (const [routeKey, routeSources] of draft.routes) {
      const source =
        routeSources.find((candidate) => candidate.slug.toLowerCase() === baseSlug(candidate)) ??
        routeSources[0]!;
      const label = modelRouteLabel(source, name);
      // Aliases of one model in one harness ("opus", "sonnet" → K3.1 Pro) are one route.
      const labelKey = `${source.instanceId}\u0000${label}`;
      if (seenLabels.has(labelKey)) continue;
      seenLabels.add(labelKey);
      routes.push({
        key: routeKey,
        source,
        sources: routeSources,
        label,
      });
    }
    nameAccountsAsPlans(routes);
    // Best first: the family's harness ranking, then catalog order.
    const preference = PREFERRED_HARNESSES[draft.family] ?? [];
    const rank = (route: ModelRoute<T>) => {
      const harness = preference.findIndex((id) => HARNESS_MATCHERS[id]?.(route.source));
      return harness === -1 ? preference.length : harness;
    };
    return {
      key: draft.key,
      makerId: draft.makerId,
      family: draft.family,
      name,
      isLegacy: draft.sources.every((source) => source.isLegacy === true),
      // One provider's accounts sit together, its main account (the instance named after the
      // driver) first: "Google Ultra" before an added "Google Pro" whatever order they came in.
      // ACP registry agents share a driver but are different products.
      routes: routes
        .map((route, index) => ({
          route,
          index,
          rank: rank(route),
          provider: routes.findIndex(
            (other) => providerKeyOf(other.source) === providerKeyOf(route.source),
          ),
          added: route.source.instanceId === route.source.driver ? 0 : 1,
        }))
        .sort(
          (a, b) =>
            a.rank - b.rank || a.provider - b.provider || a.added - b.added || a.index - b.index,
        )
        .map(({ route }) => route),
    };
  });
  const orderOf = new Map([...drafts.values()].map((draft) => [draft.key, draft] as const));
  const makerIds = new Set(models.map((model) => model.makerId));
  return [...MAKERS.map((maker) => maker.id), OTHER_MAKER_ID]
    .filter((makerId) => makerIds.has(makerId))
    .map((makerId) => ({
      maker: modelMakerById(makerId),
      models: models
        .filter((model) => model.makerId === makerId)
        .sort((left, right) => {
          if (left.isLegacy !== right.isLegacy) return left.isLegacy ? 1 : -1;
          const a = orderOf.get(left.key)!;
          const b = orderOf.get(right.key)!;
          // A maker's main line before its older ones (Muse before Llama).
          const lineA = familyRank(makerId, a.family);
          const lineB = familyRank(makerId, b.family);
          if (lineA !== lineB) return lineA - lineB;
          const ownA = Number.isFinite(a.ownOrder);
          const ownB = Number.isFinite(b.ownOrder);
          if (ownA !== ownB) return ownA ? -1 : 1;
          return ownA ? a.ownOrder - b.ownOrder : a.order - b.order;
        }),
    }));
}

/** A chat the user started on a model, for ordering makers by use. */
export interface ModelMakerUse {
  readonly instanceId: string;
  readonly slug: string;
  /** When the chat started, in epoch ms. */
  readonly at: number;
}

/** The chats someone started themselves, as maker uses: what they pick, not what agents spawn. */
export function makerUsesOf(
  chats: ReadonlyArray<{
    readonly source: { readonly createdBy: string };
    readonly modelSelection?: { readonly instanceId: string; readonly model: string } | undefined;
    readonly createdAt: string;
  }>,
): ModelMakerUse[] {
  const uses: ModelMakerUse[] = [];
  for (const chat of chats) {
    if (chat.source.createdBy !== "user" || chat.modelSelection === undefined) continue;
    const at = Date.parse(chat.createdAt);
    if (!Number.isFinite(at)) continue;
    uses.push({ instanceId: chat.modelSelection.instanceId, slug: chat.modelSelection.model, at });
  }
  return uses;
}

const DAY_MS = 86_400_000;
/** A chat this many days old counts half as much as one started today. */
const USE_HALF_LIFE_DAYS = 21;
const USE_WINDOW_DAYS = 120;

/**
 * Makers in the order the user reaches for them: each chat counts for its model's maker,
 * recent ones more. Makers never used keep the fixed order, after the used ones. The model
 * a chat names is matched against `sources` (any harness), else read from its slug.
 */
export function orderMakersByUse<M extends ModelMaker>(
  makers: ReadonlyArray<M>,
  uses: ReadonlyArray<ModelMakerUse>,
  sources: ReadonlyArray<ModelRouteSource>,
  now: number,
): M[] {
  const byRoute = new Map(
    sources.map((source) => [`${source.instanceId}\u0000${source.slug}`, source]),
  );
  const score = new Map<string, number>();
  for (const use of uses) {
    const age = Math.max(0, now - use.at) / DAY_MS;
    if (age > USE_WINDOW_DAYS) continue;
    const source = byRoute.get(`${use.instanceId}\u0000${use.slug}`) ?? {
      instanceId: use.instanceId,
      driver: "",
      instanceName: "",
      slug: use.slug,
      name: use.slug,
    };
    const makerId = modelMakerForFamily(modelVendorFamily(source)).id;
    score.set(makerId, (score.get(makerId) ?? 0) + 0.5 ** (age / USE_HALF_LIFE_DAYS));
  }
  // Other stays last however often it is used: it is the catch-all, not a maker.
  const last = (maker: M) => (maker.id === OTHER_MAKER_ID ? 1 : 0);
  return makers
    .map((maker, index) => ({ maker, index, score: score.get(maker.id) ?? 0 }))
    .sort(
      (left, right) =>
        last(left.maker) - last(right.maker) ||
        right.score - left.score ||
        left.index - right.index,
    )
    .map(({ maker }) => maker);
}

/**
 * Orders each maker's models by how often and recently the user starts chats
 * with them (same 21-day half-life over 120 days as `orderMakersByUse`).
 * Non-legacy models stay ahead of legacy ones; unused models keep catalog order.
 */
export function orderMakerModelsByUse<T extends ModelRouteSource>(
  groups: ReadonlyArray<MakerGroup<T>>,
  uses: ReadonlyArray<ModelMakerUse>,
  sources: ReadonlyArray<ModelRouteSource>,
  now: number,
): ReadonlyArray<MakerGroup<T>> {
  if (uses.length === 0 || groups.length === 0) return groups;
  const keyByRoute = new Map<string, string>();
  const keySet = new Set<string>();
  for (const group of groups) {
    for (const model of group.models) {
      keySet.add(model.key);
      for (const route of model.routes) {
        for (const source of route.sources) {
          keyByRoute.set(`${source.instanceId}\u0000${source.slug}`, model.key);
        }
      }
    }
  }
  const bySourceRoute = new Map(
    sources.map((source) => [`${source.instanceId}\u0000${source.slug}`, source]),
  );
  const scores = new Map<string, number>();
  for (const use of uses) {
    const age = Math.max(0, now - use.at) / DAY_MS;
    if (age > USE_WINDOW_DAYS) continue;
    const routeRef = `${use.instanceId}\u0000${use.slug}`;
    let modelKey = keyByRoute.get(routeRef);
    if (modelKey === undefined) {
      const source = bySourceRoute.get(routeRef) ?? {
        instanceId: use.instanceId,
        driver: "",
        instanceName: "",
        slug: use.slug,
        name: use.slug,
      };
      const family = modelVendorFamily(source);
      const maker = modelMakerForFamily(family);
      const candidate = `${maker.id}:${canonicalModelId(source, family)}`;
      if (keySet.has(candidate)) modelKey = candidate;
    }
    if (modelKey === undefined) continue;
    scores.set(modelKey, (scores.get(modelKey) ?? 0) + 0.5 ** (age / USE_HALF_LIFE_DAYS));
  }
  if (scores.size === 0) return groups;
  return groups.map((group) => {
    if (group.models.length < 2) return group;
    let hasScored = false;
    for (const model of group.models) {
      if ((scores.get(model.key) ?? 0) > 0) {
        hasScored = true;
        break;
      }
    }
    if (!hasScored) return group;
    const ordered = group.models
      .map((model, index) => ({ model, index, score: scores.get(model.key) ?? 0 }))
      .sort(
        (left, right) =>
          (left.model.isLegacy === right.model.isLegacy ? 0 : left.model.isLegacy ? 1 : -1) ||
          right.score - left.score ||
          left.index - right.index,
      )
      .map(({ model }) => model);
    return { ...group, models: ordered };
  });
}

/** The maker list, without the `MakerModel` ids: for rails and filters. */
export function modelMakerById(makerId: string): ModelMaker {
  const { families: _families, ...maker } = MAKERS.find((entry) => entry.id === makerId) ?? {
    ...OTHER_MAKER,
    families: [],
  };
  return maker;
}

/** A route's (instance, slug) pair, for remembering the one last used. */
export interface ModelRouteRef {
  readonly instanceId: string;
  readonly slug: string;
}

export function modelRouteHasSlug(
  route: ModelRoute<ModelRouteSource>,
  ref: ModelRouteRef,
): boolean {
  return (
    route.source.instanceId === ref.instanceId &&
    route.sources.some((source) => source.slug === ref.slug)
  );
}

/**
 * A route picked over a model's default, with the default it was picked over. The pick
 * holds while that default stands. Once another route becomes the default, the pick was
 * made without it on offer and says nothing about it.
 */
export interface ModelRouteChoice extends ModelRouteRef {
  readonly over?: ModelRouteRef | undefined;
}

/**
 * A family with a single preferred harness is run by its maker's own harness (Muse Code
 * for Muse, Codex for GPT), which is where that maker's plan is spent; open families rank
 * several harnesses and have none.
 */
function runsOnMakersOwnHarness<T extends ModelRouteSource>(
  model: MakerModel<T>,
  route: ModelRoute<T>,
): boolean {
  const preferred = PREFERRED_HARNESSES[model.family];
  if (preferred?.length !== 1) return false;
  return HARNESS_MATCHERS[preferred[0]!]?.(route.source) === true;
}

/**
 * A harness that reaches other makers' models through a gateway account or an API key
 * (OpenCode, Pi, Hermes), so the work is billed per token. A second harness set up for one
 * maker's models (Qwen4 in Claude Code) or another plan (Cursor) is a choice, not a gateway.
 */
function isGatewayRoute(route: ModelRoute<ModelRouteSource>): boolean {
  return (
    route.source.driver === "opencode" ||
    HARNESS_MATCHERS.pi!(route.source) ||
    HARNESS_MATCHERS.hermes!(route.source)
  );
}

/**
 * The route a model opens on: the one picked over its current default, else the
 * family's best harness, else the first. Routes that can't run now are
 * passed over while another can.
 *
 * A pick from before picks recorded what they were made over still counts, except a
 * gateway route against the maker's own harness: remembered from before the plan's harness
 * offered the model, it would keep billing per token for work the plan covers.
 *
 * `account` has the last word between the user's accounts of one provider: given the route
 * chosen so far and the routes that can run, it returns the same model on another of those
 * accounts, or nothing to keep the route (see `accountRouteStep`).
 */
export function defaultModelRoute<T extends ModelRouteSource>(
  model: MakerModel<T>,
  input: {
    readonly lastUsed?: ModelRouteChoice | null | undefined;
    readonly isAvailable?: ((route: ModelRoute<T>) => boolean) | undefined;
    readonly account?:
      | ((
          route: ModelRoute<T>,
          candidates: ReadonlyArray<ModelRoute<T>>,
        ) => ModelRoute<T> | null | undefined)
      | undefined;
  } = {},
): ModelRoute<T> | null {
  const available = model.routes.filter((route) => input.isAvailable?.(route) ?? true);
  const candidates = available.length > 0 ? available : model.routes;
  const onAccount = (route: ModelRoute<T> | null | undefined) =>
    route ? (input.account?.(route, candidates) ?? route) : (route ?? null);
  const ranked = (routes: ReadonlyArray<ModelRoute<T>>) => {
    for (const harness of PREFERRED_HARNESSES[model.family] ?? []) {
      const match = routes.find((route) => HARNESS_MATCHERS[harness]?.(route.source));
      if (match) return match;
    }
    // Devin runs other makers' models on its own weekly quota: one more way to run them,
    // never the default over a route already there.
    return (
      routes.find((route) => model.family === "swe" || !isDevinRoute(route.source)) ??
      routes[0] ??
      null
    );
  };
  const best = ranked(candidates);
  const lastUsed = input.lastUsed;
  const used = lastUsed
    ? candidates.find((route) => modelRouteHasSlug(route, lastUsed))
    : undefined;
  if (!used || !lastUsed || !best) return onAccount(used ?? best);
  const stands = lastUsed.over
    ? modelRouteHasSlug(best, lastUsed.over)
    : !(runsOnMakersOwnHarness(model, best) && isGatewayRoute(used));
  return onAccount(stands ? used : best);
}

/** Finds the model a selection belongs to. */
export function findMakerModel<T extends ModelRouteSource>(
  groups: ReadonlyArray<MakerGroup<T>>,
  ref: ModelRouteRef,
): MakerModel<T> | null {
  for (const group of groups) {
    for (const model of group.models) {
      if (model.routes.some((route) => modelRouteHasSlug(route, ref))) return model;
    }
  }
  return null;
}

/** The route picked per model (`MakerModel.key`), as each device stores it. */
export type ModelRouteMemory = Readonly<Record<string, ModelRouteChoice>>;

const isRouteRef = (value: unknown): value is ModelRouteRef =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ModelRouteRef).instanceId === "string" &&
  typeof (value as ModelRouteRef).slug === "string";

/** Reads stored memory, dropping anything that isn't a route. */
export function parseModelRouteMemory(raw: string | null | undefined): ModelRouteMemory {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]): Array<[string, ModelRouteChoice]> => {
        if (!isRouteRef(entry)) return [];
        const over = (entry as ModelRouteChoice).over;
        return [
          [
            key,
            {
              instanceId: entry.instanceId,
              slug: entry.slug,
              ...(isRouteRef(over)
                ? { over: { instanceId: over.instanceId, slug: over.slug } }
                : {}),
            },
          ],
        ];
      }),
    );
  } catch {
    return {};
  }
}

/**
 * Memory after a pick. Picking the route a model would open on anyway is not a
 * preference, so it clears the entry and the model keeps following the best route as
 * harnesses come and go. Only a route chosen over that default is remembered.
 *
 * `sameAccount` tells when two routes are the user's accounts of one provider. Picking one
 * of those over the other is a choice for that chat, not a preference: new chats go to
 * whichever account has room, so it is not remembered either.
 */
export function rememberChosenModelRoute<T extends ModelRouteSource>(
  memory: ModelRouteMemory,
  model: MakerModel<T>,
  route: ModelRouteRef,
  isAvailable?: (route: ModelRoute<T>) => boolean,
  sameAccount?: (left: ModelRouteRef, right: ModelRouteRef) => boolean,
): ModelRouteMemory {
  const fallback = defaultModelRoute(model, { isAvailable });
  if (
    fallback !== null &&
    (modelRouteHasSlug(fallback, route) ||
      sameAccount?.(
        { instanceId: fallback.source.instanceId, slug: fallback.source.slug },
        route,
      ) === true)
  ) {
    if (!Object.hasOwn(memory, model.key)) return memory;
    const { [model.key]: _forgotten, ...rest } = memory;
    return rest;
  }
  return rememberModelRoute(
    memory,
    model.key,
    route,
    fallback ? { instanceId: fallback.source.instanceId, slug: fallback.source.slug } : undefined,
  );
}

/**
 * Memory after a pick, or the same object when nothing changed. `over` is the default the
 * route was picked over. Keeps the newest 200.
 */
export function rememberModelRoute(
  memory: ModelRouteMemory,
  modelKey: string,
  route: ModelRouteRef,
  over?: ModelRouteRef,
): ModelRouteMemory {
  const current = memory[modelKey];
  if (
    current?.instanceId === route.instanceId &&
    current.slug === route.slug &&
    current.over?.instanceId === over?.instanceId &&
    current.over?.slug === over?.slug
  ) {
    return memory;
  }
  const { [modelKey]: _previous, ...rest } = memory;
  const kept = Object.entries(rest).slice(-199);
  return Object.fromEntries([
    ...kept,
    [modelKey, { instanceId: route.instanceId, slug: route.slug, ...(over ? { over } : {}) }],
  ]);
}

/** A provider's catalog, as far as routing a model needs it. */
export interface RoutedProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName?: string | undefined;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly subProvider?: string | undefined;
    readonly family?: string | undefined;
    readonly isLegacy?: boolean | undefined;
  }>;
}

// Grouping every model is too much to redo per render; a provider list is replaced, not edited.
const groupsOfProviders = new WeakMap<object, ReadonlyArray<MakerGroup<ModelRouteSource>>>();

/**
 * Where a model remembered on a gateway should run now, or null to leave it. Device history
 * names one route, but it is the model that was chosen: when the maker's own harness offers
 * that model (a plan now covers it), a new chat starts there instead of billing the gateway
 * per token. A gateway picked over that harness on this device still wins, and a chat
 * remembered on anything but a gateway (another harness, another plan) is left alone.
 */
export function ownHarnessRouteForRememberedModel(
  providers: ReadonlyArray<RoutedProvider>,
  ref: ModelRouteRef,
  options: {
    readonly memory?: ModelRouteMemory | undefined;
    readonly isHidden?: ((ref: ModelRouteRef) => boolean) | undefined;
  } = {},
): ModelRouteRef | null {
  let groups = groupsOfProviders.get(providers);
  if (!groups) {
    groups = groupModelsByMaker(
      providers.flatMap((provider) =>
        provider.models.map((entry): ModelRouteSource => ({
          instanceId: provider.instanceId,
          driver: provider.driver,
          instanceName: provider.displayName ?? provider.instanceId,
          slug: entry.slug,
          name: entry.name,
          ...(entry.subProvider ? { subProvider: entry.subProvider } : {}),
          ...(entry.family ? { family: entry.family } : {}),
          isLegacy: entry.isLegacy === true,
        })),
      ),
    );
    groupsOfProviders.set(providers, groups);
  }
  const model = findMakerModel(groups, ref);
  const current = model?.routes.find((route) => modelRouteHasSlug(route, ref));
  if (!model || !current || !isGatewayRoute(current)) return null;
  const route = defaultModelRoute(model, {
    lastUsed: options.memory?.[model.key],
    isAvailable: (candidate) =>
      !options.isHidden?.({ instanceId: candidate.source.instanceId, slug: candidate.source.slug }),
  });
  if (!route || route === current || !runsOnMakersOwnHarness(model, route)) return null;
  return { instanceId: route.source.instanceId, slug: route.source.slug };
}

/**
 * `ownHarnessRouteForRememberedModel` in the shape the new-chat resolver asks for. `memory`
 * is read when asked, so a route picked a moment ago counts; `preferences` are the saved
 * per-instance model preferences, whose hidden models are no place to send a chat.
 */
export function stickyModelRerouter(input: {
  readonly memory: () => ModelRouteMemory;
  readonly preferences?:
    | Readonly<Record<string, { readonly hiddenModels?: ReadonlyArray<string> } | undefined>>
    | null
    | undefined;
}): (
  selection: { readonly instanceId: string; readonly model: string },
  providers: ReadonlyArray<RoutedProvider>,
) => { readonly instanceId: string; readonly model: string } | null {
  return (selection, providers) => {
    const route = ownHarnessRouteForRememberedModel(
      providers,
      { instanceId: selection.instanceId, slug: selection.model },
      {
        memory: input.memory(),
        isHidden: (ref) =>
          input.preferences?.[ref.instanceId]?.hiddenModels?.includes(ref.slug) === true,
      },
    );
    return route ? { instanceId: route.instanceId, model: route.slug } : null;
  };
}
