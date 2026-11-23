/**
 * Session boxes show each chat as a small square: a painted picture of what the chat is
 * about (its topic), a short name, the agent's mascot, and, while it works, a painted
 * picture of what it is doing right now (its activity). These lists are the shared
 * vocabulary of the web and mobile boxes, their painted icons and the tiny local models.
 * Ids are stable: the trained models and the icon files are keyed by them.
 */

export const SESSION_BOX_TOPICS = [
  "app",
  "mobile",
  "website",
  "server",
  "gpu",
  "training",
  "model",
  "benchmark",
  "bug",
  "review",
  "build",
  "cleanup",
  "network",
  "devices",
  "security",
  "data",
  "research",
  "question",
  "writing",
  "design",
  "media",
  "science",
  "bot",
  "agents",
  "money",
  "settings",
  "test",
  "general",
] as const;
export type SessionBoxTopic = (typeof SESSION_BOX_TOPICS)[number];

/** What each topic covers, for people and for the labeling prompt that trains the models. */
export const SESSION_BOX_TOPIC_INFO: Record<
  SessionBoxTopic,
  { readonly name: string; readonly covers: string; readonly picture: string }
> = {
  app: {
    name: "App",
    covers: "features and UX of an app (desktop or general), screens, flows",
    picture: "an app window with a few colorful panels",
  },
  mobile: {
    name: "Mobile",
    covers: "iPhone, iPad and Android apps, sideloading, phone UX",
    picture: "a smartphone",
  },
  website: {
    name: "Website",
    covers: "websites, web pages, landing pages, blogs, frontend sites",
    picture: "a globe inside a browser frame",
  },
  server: {
    name: "Server",
    covers: "servers, backends, workstations, hosting, deployments, services",
    picture: "a server rack with small lights",
  },
  gpu: {
    name: "GPU",
    covers: "graphics cards, GPU kernels, VRAM, hardware acceleration",
    picture: "a graphics card with a fan",
  },
  training: {
    name: "Training",
    covers: "training, fine-tuning or distilling machine learning models, datasets for training",
    picture: "a glowing brain made of connected nodes",
  },
  model: {
    name: "AI model",
    covers: "using or comparing AI models, inference, prompts, LLM behavior",
    picture: "a crystal ball with a spark inside",
  },
  benchmark: {
    name: "Benchmark",
    covers: "speed tests, benchmarks, evals, measuring performance or quality",
    picture: "a stopwatch",
  },
  bug: {
    name: "Bug",
    covers: "fixing bugs, crashes, errors, troubleshooting something broken",
    picture: "a beetle",
  },
  review: {
    name: "Review",
    covers: "code review, audits, checking someone else's work or a diff",
    picture: "a magnifying glass over a page of code",
  },
  build: {
    name: "Build",
    covers: "building, packaging, releasing and installing software",
    picture: "a hammer and a wrench crossed",
  },
  cleanup: {
    name: "Cleanup",
    covers: "freeing disk space, deleting junk, tidying files, refactors that remove things",
    picture: "a broom sweeping",
  },
  network: {
    name: "Network",
    covers: "Wi-Fi, hotspots, VPNs, SSH connections, DNS, networking problems",
    picture: "Wi-Fi waves above an antenna",
  },
  devices: {
    name: "Devices",
    covers: "physical devices and peripherals: printers, iPads, Raspberry Pi, drives, cables",
    picture: "a printer",
  },
  security: {
    name: "Security",
    covers: "keys, passwords, auth, permissions, privacy, vulnerabilities",
    picture: "a padlock",
  },
  data: {
    name: "Data",
    covers: "data analysis, statistics, downloads counts, spreadsheets, databases",
    picture: "a bar chart",
  },
  research: {
    name: "Research",
    covers: "researching a topic, comparing options, reading papers or posts, investigating",
    picture: "an open book with a bookmark",
  },
  question: {
    name: "Question",
    covers: "a quick question, explanation or short conversation",
    picture: "a speech bubble with a question mark",
  },
  writing: {
    name: "Writing",
    covers: "writing docs, posts, emails, READMEs, copy",
    picture: "a quill pen",
  },
  design: {
    name: "Design",
    covers: "visual design, art direction, animation, styling, icons",
    picture: "a paint palette with a brush",
  },
  media: {
    name: "Media",
    covers: "images, video, audio, transcription, 3D models, media generation",
    picture: "a film camera",
  },
  science: {
    name: "Science",
    covers: "simulations, physics, math, scientific visualizations",
    picture: "an atom",
  },
  bot: {
    name: "Bot",
    covers: "chat bots, Discord bots, scheduled automations, scrapers",
    picture: "a small friendly robot",
  },
  agents: {
    name: "Agents",
    covers: "AI coding agents, harnesses, orchestration, subagents, agent tooling",
    picture: "three small linked figures passing a spark",
  },
  money: {
    name: "Money",
    covers: "costs, pricing, subscriptions, usage limits, billing",
    picture: "a stack of coins",
  },
  settings: {
    name: "Setup",
    covers: "configuration, settings, installing tools, environment setup",
    picture: "a gear",
  },
  test: {
    name: "Testing",
    covers: "QA, test suites, verifying behavior, load tests",
    picture: "a test tube with bubbles",
  },
  general: {
    name: "Chat",
    covers: "anything else, or not enough information",
    picture: "a four-pointed spark",
  },
};

/** What the agent is doing at this moment. */
export const SESSION_BOX_ACTIVITIES = [
  "thinking",
  "replying",
  "reading",
  "searching",
  "editing",
  "testing",
  "building",
  "running",
  "installing",
  "git",
  "browsing",
  "remote",
  "gpu",
  "delegating",
  "waiting",
] as const;
export type SessionBoxActivity = (typeof SESSION_BOX_ACTIVITIES)[number];

export const SESSION_BOX_ACTIVITY_INFO: Record<
  SessionBoxActivity,
  { readonly verb: string; readonly picture: string }
> = {
  thinking: { verb: "Thinking", picture: "a lightbulb with a swirl" },
  replying: { verb: "Replying", picture: "a speech bubble being written" },
  reading: { verb: "Reading", picture: "an eye over a page" },
  searching: { verb: "Searching", picture: "a magnifying glass" },
  editing: { verb: "Editing", picture: "a pencil drawing a line" },
  testing: { verb: "Testing", picture: "a checklist with ticks" },
  building: { verb: "Building", picture: "stacked bricks with a trowel" },
  running: { verb: "Running", picture: "a rocket lifting off" },
  installing: { verb: "Installing", picture: "a box with a down arrow" },
  git: { verb: "Git", picture: "a branching path" },
  browsing: { verb: "Browsing", picture: "a compass" },
  remote: { verb: "Remote", picture: "a satellite dish" },
  gpu: { verb: "GPU", picture: "a hot glowing chip" },
  delegating: { verb: "Delegating", picture: "two hands passing a baton" },
  waiting: { verb: "Waiting", picture: "an hourglass" },
};

/**
 * What the agent's last reply asks of the user. The first three need the user; `review`
 * means results are ready to look at; `done` and `progress` need nothing right now.
 */
export const SESSION_BOX_ATTENTION = [
  "question",
  "decision",
  "blocked",
  "review",
  "done",
  "progress",
] as const;
export type SessionBoxAttention = (typeof SESSION_BOX_ATTENTION)[number];

/** Pictures for states that override topic and activity. */
export const SESSION_BOX_STATES = ["asking", "done", "failed", "limited"] as const;
export type SessionBoxState = (typeof SESSION_BOX_STATES)[number];

export const SESSION_BOX_STATE_INFO: Record<SessionBoxState, { readonly picture: string }> = {
  asking: { picture: "a raised hand" },
  done: { picture: "a check mark in one brush stroke" },
  failed: { picture: "a cracked plate" },
  limited: { picture: "an empty fuel gauge" },
};

/** A topic's further paintings, after its first (`topic-<id>`): `topic-<id>-2` and on. */
export const SESSION_BOX_FACE_VARIANTS = [2, 3, 4, 5, 6] as const;
export type SessionBoxFaceVariant = (typeof SESSION_BOX_FACE_VARIANTS)[number];

/** The first painting of each topic, and every activity and state picture. */
export type SessionBoxBaseIconId =
  | `topic-${SessionBoxTopic}`
  | `activity-${SessionBoxActivity}`
  | `state-${SessionBoxState}`;

/**
 * Every painted icon the boxes use, keyed `topic-<id>` (or `topic-<id>-<n>` for a topic's
 * other paintings), `activity-<id>` or `state-<id>`.
 */
export type SessionBoxIconId =
  | SessionBoxBaseIconId
  | `topic-${SessionBoxTopic}-${SessionBoxFaceVariant}`;

/** The first painting of an icon's subject: what line fallbacks are drawn for. */
export function sessionBoxBaseIconId(id: SessionBoxIconId): SessionBoxBaseIconId {
  return id.replace(/-\d+$/u, "") as SessionBoxBaseIconId;
}

export const SESSION_BOX_ICON_IDS: ReadonlyArray<SessionBoxBaseIconId> = [
  ...SESSION_BOX_TOPICS.map((id) => `topic-${id}` as const),
  ...SESSION_BOX_ACTIVITIES.map((id) => `activity-${id}` as const),
  ...SESSION_BOX_STATES.map((id) => `state-${id}` as const),
];
