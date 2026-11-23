import { harnessMascotLoaders } from "./harnessMascotLoaders.ts";

export type HarnessMascotState =
  | "idle"
  | "greet"
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "idea";
export type HarnessMascotId = keyof typeof harnessMascotLoaders;
export type HarnessMascotAnimation = {
  readonly variant: string;
  readonly weight: number;
  readonly longTurnOnly: boolean;
  readonly pixelSize: number | null;
  readonly file: string;
  /** The same sheet in light ink, for a flat pet that would vanish on a dark theme. */
  readonly darkFile?: string;
  /** Where in the animation a still picture of the state is taken. Zero when absent. */
  readonly posterMs?: number;
  readonly columns: number;
  readonly rows: number;
  readonly durations: ReadonlyArray<number>;
  readonly repeats: number | null;
};
type HarnessMascotAnimations = Record<
  HarnessMascotState,
  readonly [HarnessMascotAnimation, ...HarnessMascotAnimation[]]
>;
const loadedAnimations = new Map<HarnessMascotId, HarnessMascotAnimations>();
const pendingAnimations = new Map<HarnessMascotId, Promise<HarnessMascotAnimations>>();

/** Loading a pet never evaluates the other pets' frame data. Shared by both clients. */
export function loadHarnessMascotAnimations(id: HarnessMascotId) {
  let pending = pendingAnimations.get(id);
  if (!pending) {
    pending = harnessMascotLoaders[id]()
      .then((module) => {
        loadedAnimations.set(id, module.default);
        return module.default;
      })
      .catch((error: unknown) => {
        pendingAnimations.delete(id);
        throw error;
      });
    pendingAnimations.set(id, pending);
  }
  return pending;
}

type HarnessMascotDefinition = {
  readonly name: string;
  readonly pixelArt: boolean;
  readonly driver: string;
  readonly agentIds?: ReadonlyArray<string>;
  /** The harness's identity hue: the new-chat horizon and its backdrop. */
  readonly tint: `#${string}`;
  /**
   * A maker's pet with no harness of its own. It fronts that maker's models in harnesses that
   * run many makers' models, so its hue never has to stand apart from the harnesses'.
   */
  readonly modelFamilyOnly?: true;
};

/**
 * Visual identities are independent of themes and the live provider catalog. Hues
 * match each harness's own brand (Claude #d97757, as its theme uses).
 */
export const HARNESS_MASCOTS = {
  claude: {
    name: "Clawd",
    pixelArt: true,
    driver: "claudeAgent",
    agentIds: ["claude-acp"],
    tint: "#d97757",
  },
  codex: {
    name: "Byte",
    pixelArt: false,
    driver: "codex",
    agentIds: ["codex-acp"],
    tint: "#9db9ff",
  },
  grok: { name: "Grok Bot", pixelArt: false, driver: "grok", tint: "#b9bdc6" },
  muse: { name: "Jolly", pixelArt: false, driver: "muse", tint: "#6a4ff0" },
  cursor: { name: "Nib", pixelArt: false, driver: "cursor", tint: "#38c2dc" },
  opencode: {
    name: "Otto",
    pixelArt: false,
    driver: "opencode",
    agentIds: ["opencode"],
    tint: "#3ccf91",
  },
  pi: { name: "Pip", pixelArt: false, driver: "pi", tint: "#a8d454" },
  kimi: {
    // Kimi's own glass orb. Its brand blue (#1783ff) could not be told from Orbit's glow.
    name: "Kimi",
    pixelArt: false,
    driver: "acpRegistry",
    agentIds: ["kimi", "kimi-code"],
    tint: "#00a8ff",
  },
  mistral: {
    name: "Le Chonk",
    // Mistral draws its cat in squares; the pixel grid keeps them sharp.
    pixelArt: true,
    driver: "acpRegistry",
    agentIds: ["mistral-vibe"],
    tint: "#fa500f",
  },
  acp: { name: "Patch", pixelArt: false, driver: "acpRegistry", tint: "#c4ad86" },
  qwen: {
    name: "Capy",
    pixelArt: false,
    driver: "acpRegistry",
    agentIds: ["qwen", "qwen-code"],
    // Lighter than Qwen's brand purple (#615ced, its theme's accent): at that exact shade the
    // glow could not be told from Muse's.
    tint: "#9a7cff",
  },
  deepseek: {
    name: "Moby",
    pixelArt: false,
    driver: "acpRegistry",
    agentIds: ["deepseek"],
    tint: "#4d6bfe",
    modelFamilyOnly: true,
  },
  // Gemini's sparkle as twins (Gemini) that float (Antigravity, Google's own agent for its models).
  gemini: {
    name: "Twins",
    pixelArt: false,
    driver: "antigravity",
    agentIds: ["gemini"],
    tint: "#3186ff",
  },
  glm: {
    name: "Zippy",
    pixelArt: false,
    driver: "acpRegistry",
    agentIds: ["glm"],
    tint: "#9ccc5a",
    modelFamilyOnly: true,
  },
  minimax: {
    name: "Wavy",
    pixelArt: false,
    driver: "acpRegistry",
    agentIds: ["minimax"],
    tint: "#e2167e",
    modelFamilyOnly: true,
  },
  // Devin's otter, rendered from the 3D plush Devin Desktop animates; its hue is Devin's blue.
  devin: {
    name: "Devin",
    pixelArt: false,
    driver: "acpRegistry",
    agentIds: ["devin"],
    tint: "#3969ca",
  },
} as const satisfies Record<HarnessMascotId, HarnessMascotDefinition>;

/** The harness's identity hue, for the horizon on both clients. */
export function harnessIdentityTint(driver: string | null | undefined, agentId?: string | null) {
  return (harnessMascotForDriver(driver, agentId) ?? HARNESS_MASCOTS.acp).tint;
}

/**
 * Model families with a pet of their own, for a chat whose harness has none: a
 * DeepSeek, Qwen, Mistral, Grok, Kimi, Gemini, GLM, MiniMax, Muse, Claude, GPT or SWE model
 * behind a generic agent still gets its maker's pet.
 */
const MODEL_FAMILY_PETS: ReadonlyArray<readonly [RegExp, string, string | null]> = [
  // First: DeepSeek's distilled models carry the base model's name too.
  [/deepseek/iu, "acpRegistry", "deepseek"],
  [/qwen/iu, "acpRegistry", "qwen"],
  [/mistral|devstral|codestral|magistral|ministral|pixtral/iu, "acpRegistry", "mistral-vibe"],
  [/grok/iu, "grok", null],
  [/kimi|moonshot/iu, "acpRegistry", "kimi"],
  [/gemini|gemma/iu, "acpRegistry", "gemini"],
  [/glm|zhipu/iu, "acpRegistry", "glm"],
  [/minimax/iu, "acpRegistry", "minimax"],
  // Cognition's SWE models (`swe-2`, `swe-1.6-fast`) run in Devin.
  [/\bswe[-.]?\d/iu, "acpRegistry", "devin"],
  [/\bmuse\b/iu, "muse", null],
  // Only the full name: a bare "opus" or "sonnet" can be an alias for another maker's model.
  [/claude/iu, "claudeAgent", null],
  [/\bgpt\b|\bgpt[-.]?\d|codex/iu, "codex", null],
];
export function harnessMascotForModel(model: string | null | undefined) {
  const slug = model?.trim() ?? "";
  if (slug.length === 0) return null;
  for (const [pattern, driver, agentId] of MODEL_FAMILY_PETS) {
    if (pattern.test(slug)) return { driver, agentId };
  }
  return null;
}

const mascotDefinitions = Object.entries<HarnessMascotDefinition>(HARNESS_MASCOTS).map(
  ([id, definition]) => ({ id: id as HarnessMascotId, ...definition }),
);

/** Registry identities come from config, never user-editable instance names. */
export function harnessMascotAgentId(driver: string | null | undefined, config: unknown) {
  if (driver !== "acpRegistry" || config === null || typeof config !== "object") return null;
  if ("source" in config && config.source === "local") return null;
  return "agentId" in config && typeof config.agentId === "string"
    ? config.agentId.trim() || null
    : null;
}

export function harnessMascotForDriver(driver: string | null | undefined, agentId?: string | null) {
  const agent = agentId?.trim();
  // Qwen Code under its own driver names, as older settings have it.
  if (driver === "qwen" || driver === "qwenCode")
    return mascotDefinitions.find((c) => c.id === "qwen")!;
  return (
    (driver === "acpRegistry" && agent
      ? mascotDefinitions.find((candidate) => candidate.agentIds?.includes(agent))
      : undefined) ??
    mascotDefinitions.find(
      (candidate) =>
        candidate.driver === driver && (driver !== "acpRegistry" || !candidate.agentIds),
    ) ??
    null
  );
}

export function harnessMascotVariants(id: HarnessMascotId, state: HarnessMascotState) {
  const animations = loadedAnimations.get(id);
  if (!animations) throw new Error(`Load ${id}'s mascot animations before starting its player.`);
  return animations[state];
}

export function harnessMascotAnimation(
  id: HarnessMascotId,
  state: HarnessMascotState,
  variant = 0,
) {
  const variants = harnessMascotVariants(id, state);
  return variants[variant] ?? variants[0];
}

export function harnessMascotDuration(id: HarnessMascotId, state: HarnessMascotState, variant = 0) {
  return harnessMascotAnimation(id, state, variant).durations.reduce(
    (sum: number, duration) => sum + duration,
    0,
  );
}

/** Pure clock resolution lets clients pause by accumulating only visible time. */
export function resolveHarnessMascotFrame(
  id: HarnessMascotId,
  requestedState: HarnessMascotState,
  elapsedMs: number,
  variant = 0,
) {
  let state = requestedState;
  let elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const requested = harnessMascotAnimation(id, state, variant);
  const duration = harnessMascotDuration(id, state, variant);
  if (requested.repeats !== null && elapsed >= duration * requested.repeats) {
    elapsed -= duration * requested.repeats;
    state = "idle";
    variant = 0;
  }
  const animation = harnessMascotAnimation(id, state, variant);
  let remaining = elapsed % harnessMascotDuration(id, state, variant);
  let index = 0;
  for (const frameMs of animation.durations) {
    if (remaining < frameMs) break;
    remaining -= frameMs;
    index++;
  }
  return {
    state,
    index,
    file: animation.file,
    darkFile: animation.darkFile,
    pixelSize: animation.pixelSize,
    columns: animation.columns,
    rows: animation.rows,
    column: index % animation.columns,
    row: Math.floor(index / animation.columns),
    nextMs: Math.max(1, animation.durations[index]! - remaining),
  };
}

/** One player per mounted mascot; its clock advances only while the client is visible. */
export function createHarnessMascotPlayer(
  id: HarnessMascotId,
  { random = Math.random, now = () => 0 }: { random?: () => number; now?: () => number } = {},
) {
  const previous: Partial<Record<HarnessMascotState, number>> = {};
  let requested: HarnessMascotState | undefined;
  let playing: HarnessMascotState = "idle";
  let variant = 0;
  let started = 0;
  let driftAt = Infinity;
  let workingSince: number | undefined;
  let longTurn = false;
  const sample = () => Math.max(0, Math.min(0.999999, random()));
  const select = (state: HarnessMascotState, clock: number) => {
    const choices = harnessMascotVariants(id, state);
    const eligible = choices
      .map((animation, index) => ({ animation, index }))
      .filter(({ animation }) => !animation.longTurnOnly || longTurn);
    const alternatives = eligible.filter(({ index }) => index !== previous[state]);
    const candidates = alternatives.length ? alternatives : eligible;
    let weight = sample() * candidates.reduce((sum, entry) => sum + entry.animation.weight, 0);
    const chosen =
      candidates.find((entry) => (weight -= entry.animation.weight) < 0) ?? candidates[0]!;
    variant = chosen.index;
    previous[state] = variant;
    playing = state;
    started = clock;
    driftAt = state === "idle" ? clock + 20_000 + sample() * 40_000 : Infinity;
  };
  return {
    frame(state: HarnessMascotState, clock = now(), completedTurnMs = 0) {
      clock = Math.max(0, Number.isFinite(clock) ? clock : 0);
      if (state !== requested) {
        if (state === "working" && workingSince === undefined) workingSince = clock;
        longTurn =
          state === "done" &&
          (completedTurnMs >= 60_000 ||
            (workingSince !== undefined && clock - workingSince >= 60_000));
        if (state !== "working" && state !== "waiting") workingSince = undefined;
        requested = state;
        const active = harnessMascotAnimation(id, playing, variant);
        const finishing =
          state === "idle" &&
          (playing === "done" ||
            playing === "failed" ||
            playing === "greet" ||
            playing === "idea") &&
          active.repeats !== null &&
          clock < started + harnessMascotDuration(id, playing, variant) * active.repeats;
        if (!finishing) select(state, clock);
      }
      const animation = harnessMascotAnimation(id, playing, variant);
      const end =
        started + harnessMascotDuration(id, playing, variant) * (animation.repeats ?? Infinity);
      if (clock >= end) select("idle", end);
      if (clock >= driftAt) select("idle", clock);
      const frame = resolveHarnessMascotFrame(id, playing, clock - started, variant);
      return { ...frame, nextMs: Math.min(frame.nextMs, Math.max(1, driftAt - clock)) };
    },
  };
}

/** Completed run timing also reaches mascots mounted only for the result label. */
export function harnessMascotCompletedTurnDuration(
  run:
    | { readonly startedAt?: string | null; readonly completedAt?: string | null }
    | null
    | undefined,
) {
  if (!run?.startedAt || !run.completedAt) return 0;
  const duration = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

export function harnessMascotTurnState(
  working: boolean,
  waiting: boolean,
  outcome: HarnessMascotState | null,
): HarnessMascotState {
  return waiting ? "waiting" : working ? "working" : (outcome ?? "idle");
}

/**
 * The pet a build shows on its empty screens, ahead of the harness a new chat opens with: Codex's
 * here. Null makes the pet follow the default harness. Chats keep their own harness's pet
 * either way.
 */
export const BUILD_DEFAULT_MASCOT_DRIVER: string | null = "codex";

/** Empty states follow the configured default, then the catalog's implicit default. */
export function defaultHarnessMascotProvider<
  T extends {
    readonly instanceId: string;
    readonly driver: string;
    readonly enabled: boolean;
    readonly isHarnessDefault?: boolean | undefined;
    readonly models: ReadonlyArray<{ readonly isDefault?: boolean | undefined }>;
  },
>(providers: ReadonlyArray<T>, selectedInstanceId: string | null | undefined) {
  if (selectedInstanceId)
    return providers.find((provider) => provider.instanceId === selectedInstanceId) ?? null;
  const available = providers.filter((provider) => provider.enabled);
  return (
    available.find((provider) => provider.isHarnessDefault) ??
    available.find((provider) => provider.models.some((model) => model.isDefault)) ??
    available[0] ??
    null
  );
}

export function defaultHarnessMascotDriver(
  providers: Parameters<typeof defaultHarnessMascotProvider>[0],
  selectedInstanceId: string | null | undefined,
) {
  return defaultHarnessMascotProvider(providers, selectedInstanceId)?.driver ?? null;
}

/** Reduced motion keeps a readable pose, including the laptop and idea bulb. */
export function resolveHarnessMascotPosterFrame(id: HarnessMascotId, state: HarnessMascotState) {
  const restingState = state === "greet" ? "idle" : state;
  const poseMs =
    harnessMascotAnimation(id, restingState).posterMs ??
    (id === "claude" && (state === "waiting" || state === "idea") ? 1500 : 0);
  return resolveHarnessMascotFrame(id, restingState, poseMs);
}
