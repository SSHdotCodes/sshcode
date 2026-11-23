import type { PreviewAutomationSnapshot, PreviewObservationOptions } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const MAX_BYTES = 20_000;
const MAX_BASELINES = 128;
const BASELINE_TTL_MS = 15 * 60_000;
// An action's page change rides along only while it stays smaller than this.
const MAX_ACTION_CHANGE_CHARS = 3_000;

interface Observation {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly tabId?: string;
  readonly snapshotId: string;
  readonly mode: "compact" | "interactive" | "full";
  readonly tree?: string;
  readonly baseSnapshotId?: string;
  readonly unchanged?: boolean;
  readonly changes?: readonly {
    readonly fromLine: number;
    readonly deleteCount: number;
    readonly lines: readonly string[];
  }[];
  readonly omitted?: readonly string[];
  readonly diagnostics?: {
    readonly console: readonly { readonly level: string; readonly text: string }[];
    readonly network: readonly {
      readonly url: string;
      readonly status: number | null;
      readonly error?: string;
    }[];
    readonly actions: readonly {
      readonly action: string;
      readonly status: string;
      readonly error?: string;
    }[];
  };
}

interface Baseline {
  readonly scope: string;
  readonly options: string;
  readonly input: PreviewObservationOptions;
  readonly tree: string;
  readonly metadata: string;
  readonly expiresAt: number;
}

// Prefer complete lines so a bounded tree retains usable selectors.
const boundedTree = (tree: string, limit: number) => {
  if (limit <= 1) return "";
  if (tree.length <= limit) return tree;
  const end = tree.lastIndexOf("\n", limit);
  return end > 0
    ? tree.slice(0, end)
    : `${tree.slice(0, Math.max(0, limit - 1)).replace(/\s*\[ref=[^\]]*$/, "")}…`;
};

const boundedIdentity = (text: string, chars: number, bytes: number) => {
  let value = text.slice(0, chars);
  while (Buffer.byteLength(encode(value), "utf8") > bytes)
    value = value.slice(0, Math.floor(value.length * 0.75));
  return value;
};

interface TreeNode {
  readonly line: string;
  readonly children: TreeNode[];
}

const parseTree = (raw: string): TreeNode[] => {
  const roots: TreeNode[] = [];
  const open: Array<{ readonly indent: number; readonly children: TreeNode[] }> = [
    { indent: -1, children: roots },
  ];
  for (const line of raw.split("\n")) {
    const indent = line.search(/\S/);
    if (indent < 0) continue;
    while (open.length > 1 && open.at(-1)!.indent >= indent) open.pop();
    const node: TreeNode = { line: line.slice(indent), children: [] };
    open.at(-1)!.children.push(node);
    open.push({ indent, children: node.children });
  }
  return roots;
};

// `- key`, `- key:` or `- key: value`. AI snapshots single-quote a key that holds ': '.
const splitItem = (line: string) => {
  const body = line.startsWith("- ") ? line.slice(2) : line;
  let key = "";
  let rest: string;
  if (body.startsWith("'")) {
    let i = 1;
    for (; i < body.length; i++) {
      if (body[i] !== "'") key += body[i];
      else if (body[i + 1] === "'") key += body[++i];
      else break;
    }
    rest = body.slice(i + 1);
  } else {
    let i = 0;
    let quoted = false;
    for (; i < body.length; i++) {
      const char = body[i];
      if (quoted) {
        if (char === "\\") i++;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === ":" && (i + 1 === body.length || body[i + 1] === " ")) break;
    }
    key = body.slice(0, i);
    rest = body.slice(i);
  }
  return { key, value: rest.startsWith(": ") ? rest.slice(2) : undefined };
};

const ITEM_KEY = /^([\w-]+)(?: ("(?:\\.|[^"\\])*"))?(.*)$/;
const ACTIONABLE_ROLE =
  /^(?:button|link|textbox|searchbox|checkbox|radio|combobox|listbox|option|menuitem(?:checkbox|radio)?|treeitem|slider|spinbutton|switch|tab)$/;
// Wrappers that only group their content; their children take their place.
const WRAPPER_ROLE = /^(?:generic|group|rowgroup|none|presentation)$/;
// Layout containers that say nothing when unnamed and holding at most one child.
const LAYOUT_ROLE = /^(?:table|row|cell|gridcell|list|listitem)$/;

const unquote = (text: string) => {
  if (!text.startsWith('"')) return text;
  try {
    return String(JSON.parse(text));
  } catch {
    return text.slice(1, -1);
  }
};

// Letters and digits only: separators and spacing differ between a computed name and its parts.
const comparable = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// The name's words appear in order in the content, which may hold more (titles, icons).
const spells = (content: string, name: string) => {
  const wanted = words(name);
  if (wanted.length === 0) return false;
  let next = 0;
  for (const word of words(content)) {
    if (word === wanted[next] && ++next === wanted.length) return true;
  }
  return false;
};

const textOf = (nodes: readonly TreeNode[]): string =>
  nodes
    .map((node) => {
      const { key, value } = splitItem(node.line);
      if (key.startsWith("/")) return "";
      const name = ITEM_KEY.exec(key)?.[2];
      return `${name === undefined ? "" : unquote(name)} ${value === undefined ? "" : unquote(value)} ${textOf(node.children)}`;
    })
    .join(" ");

const renderKey = (key: string) => (/:(?: |$)/.test(key) ? `'${key.replaceAll("'", "''")}'` : key);

const linkUrl = (node: TreeNode) => {
  for (const child of node.children) {
    const { key, value } = splitItem(child.line);
    if (key === "/url" && value !== undefined) return unquote(value);
  }
  return undefined;
};

const siteOf = (host: string) => host.replace(/^www\./, "");

// An address on another site says where a link leads. The page's own paths
// (a third of a GitHub page) add nothing to acting by ref; full mode has them.
const keepsUrl = (url: string, pageSite: string | undefined) => {
  if (/^javascript:/i.test(url)) return false;
  try {
    return siteOf(new URL(url).host) !== pageSite;
  } catch {
    return false;
  }
};

// Keep task text and states, but spend refs on controls and drop what the
// children already say. Full mode exposes static-node refs too, for sites with
// unusual non-semantic click targets.
const compactNodes = (nodes: readonly TreeNode[], pageSite: string | undefined): TreeNode[] => {
  const linksByUrl = new Map<string, number>();
  for (const node of nodes) {
    const url = linkUrl(node);
    if (url !== undefined) linksByUrl.set(url, (linksByUrl.get(url) ?? 0) + 1);
  }
  return nodes.flatMap((node): TreeNode[] => {
    const { key, value } = splitItem(node.line);
    const item = ITEM_KEY.exec(key);
    if (key === "/url") {
      return value !== undefined && keepsUrl(unquote(value), pageSite) ? [node] : [];
    }
    let children = compactNodes(node.children, pageSite);
    if (key.startsWith("/") || item === null) return [{ line: node.line, children }];
    const role = item[1]!;
    let name = item[2];
    // A link split around another, like GitHub's `)` after a PR number, whose
    // sibling already goes to the same place.
    if (role === "link" && name !== undefined && comparable(unquote(name)) === "") {
      const url = linkUrl(node);
      if (url !== undefined && (linksByUrl.get(url) ?? 0) > 1) return [];
    }
    let attributes = item[3]!.replace(/ \[box=[^\]]*\]/g, "");
    const semantic = ACTIONABLE_ROLE.test(role);
    const actionable =
      semantic || /\[(?:cursor=pointer|checked|selected|expanded|pressed)/.test(attributes);
    if (!actionable) attributes = attributes.replace(/ \[ref=[^\]]+\]/g, "");
    if (semantic) attributes = attributes.replace(" [cursor=pointer]", "");
    // Icons, titles and labels inside a control that its name already says.
    // Controls always keep their names, so nothing is lost.
    if (actionable && name !== undefined) {
      const own = unquote(name);
      children = children.filter((child) => {
        if (child.children.length > 0) return true;
        const childItem = splitItem(child.line);
        const childKey = ITEM_KEY.exec(childItem.key);
        if (childKey === null || !/^(?:generic|img|text|paragraph)$/.test(childKey[1]!)) {
          return true;
        }
        if (/ \[ref=/.test(childKey[3]!)) return true;
        const text = unquote(childKey[2] ?? childItem.value ?? "");
        return !spells(own, text);
      });
    }
    // `|`, `(` and `)` between links.
    if (role === "text" && value !== undefined && comparable(unquote(value)) === "") return [];
    // A computed name repeats its content. Unique ARIA labels stay.
    if (
      name !== undefined &&
      !actionable &&
      children.length > 0 &&
      spells(textOf(node.children), unquote(name))
    ) {
      name = undefined;
    }
    const bare = name === undefined && value === undefined && /^(?: \[active\])?$/.test(attributes);
    if (bare && WRAPPER_ROLE.test(role)) return children;
    if (bare && LAYOUT_ROLE.test(role) && children.length <= 1) return children;
    if (bare && role === "img" && children.length === 0) return [];
    const itemKey = `${role}${name === undefined ? "" : ` ${name}`}${attributes}`;
    const tail = value !== undefined ? `: ${value}` : children.length > 0 ? ":" : "";
    return [{ line: `- ${renderKey(itemKey)}${tail}`, children }];
  });
};

// Kept in interactive mode for orientation even without controls inside.
const CONTEXT_ROLE =
  /^(?:heading|status|alert|alertdialog|dialog|banner|navigation|main|search|form|contentinfo|complementary)$/;
// Unnamed groupings worth keeping when they hold several controls.
const GROUP_ROLE = /^(?:row|listitem|list|table|menu|menubar|tablist|toolbar|radiogroup|tree)$/;

const isControl = (node: TreeNode) =>
  / \[ref=/.test(ITEM_KEY.exec(splitItem(node.line).key)?.[3] ?? "");
const holdsControl = (nodes: readonly TreeNode[]): boolean =>
  nodes.some((node) => isControl(node) || holdsControl(node.children));

// Controls with refs, plus the headings, landmarks, alerts and labelled
// containers that say where they are. Paragraph text is dropped.
const interactiveNodes = (nodes: readonly TreeNode[], inGroup = false): TreeNode[] =>
  nodes.flatMap((node): TreeNode[] => {
    const { key, value } = splitItem(node.line);
    if (key.startsWith("/") || isControl(node)) return [node];
    const item = ITEM_KEY.exec(key);
    const role = item?.[1] ?? "";
    const group = GROUP_ROLE.test(role);
    const children = interactiveNodes(node.children, group);
    if (CONTEXT_ROLE.test(role)) return [{ line: node.line, children }];
    // A short label beside a row's or item's controls says which one they act on.
    const label = item?.[2] ?? value;
    if (inGroup && node.children.length === 0 && label !== undefined && label.length <= 120) {
      return [node];
    }
    if (!holdsControl(children)) return [];
    // A container's own text value is paragraph content; its name is the context.
    if (item?.[2] !== undefined || (group && children.length > 1)) {
      return [{ line: `- ${renderKey(key)}:`, children }];
    }
    return children;
  });

const renderTree = (nodes: readonly TreeNode[], depth = 0): string[] =>
  nodes.flatMap((node) => [
    `${"  ".repeat(depth)}${node.line}`,
    ...renderTree(node.children, depth + 1),
  ]);

const semanticTree = (
  snapshot: PreviewAutomationSnapshot,
  mode: "compact" | "interactive" | "full",
) => {
  const raw =
    typeof snapshot.accessibilityTree === "string"
      ? snapshot.accessibilityTree
      : [
          ...snapshot.interactiveElements.map(
            (element) =>
              `- ${element.role ?? element.tag} ${encode(element.name.slice(0, 200))} [locator=${encode(element.selector)}]`,
          ),
          snapshot.visibleText,
        ].join("\n");
  if (mode === "full" || typeof snapshot.accessibilityTree !== "string") return raw;
  let pageSite: string | undefined;
  try {
    pageSite = siteOf(new URL(snapshot.url).host);
  } catch {
    pageSite = undefined;
  }
  const compact = compactNodes(parseTree(raw), pageSite);
  return renderTree(mode === "interactive" ? interactiveNodes(compact) : compact).join("\n");
};

const patch = (before: string, after: string) => {
  const a = before.split("\n");
  const b = after.split("\n");
  const changes: Array<{ fromLine: number; deleteCount: number; lines: string[] }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    // Nearby exact-line anchors keep sparse changes sparse. The bounded window
    // avoids quadratic work on unrelated pages; a large rewrite returns full.
    let anchor: { x: number; y: number } | undefined;
    let cost = Infinity;
    for (let x = 0; x <= 32 && i + x < a.length; x++) {
      for (let y = 0; y <= 32 && j + y < b.length; y++) {
        if (x + y > 0 && x + y < cost && a[i + x] === b[j + y]) {
          anchor = { x, y };
          cost = x + y;
        }
      }
    }
    if (anchor === undefined) {
      changes.push({ fromLine: i, deleteCount: a.length - i, lines: b.slice(j) });
      break;
    }
    changes.push({ fromLine: i, deleteCount: anchor.x, lines: b.slice(j, j + anchor.y) });
    i += anchor.x;
    j += anchor.y;
  }
  return changes;
};

/** What an action changed, measured against the caller's latest look at the tab. */
export type ActionPageChange = {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly snapshotId?: string;
  readonly baseSnapshotId?: string;
  readonly unchanged?: boolean;
  readonly changes?: Observation["changes"];
  readonly note?: string;
};

export class BrowserObservations extends Context.Service<
  BrowserObservations,
  {
    readonly observe: (
      namespace: string,
      snapshot: PreviewAutomationSnapshot,
      options: PreviewObservationOptions,
    ) => Effect.Effect<Observation>;
    /**
     * After an action: the lines that changed since the caller's latest
     * observation of the tab, in that observation's mode. Undefined when the
     * caller has not observed the tab. A change too large to be worth sending
     * comes back as a note and leaves the caller's baseline where it was.
     */
    readonly observeActionChange: (
      namespace: string,
      snapshot: PreviewAutomationSnapshot,
    ) => Effect.Effect<ActionPageChange | undefined>;
  }
>()("t3/preview/BrowserObservations") {}

const make = Effect.gen(function* () {
  // Baselines are scoped to an authenticated session AND resolved tab, never a
  // URL. Explicit IDs make retries and interleaved observations unambiguous.
  const crypto = yield* Crypto.Crypto;
  const epoch = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
  let sequence = 0;
  const baselines = new Map<string, Baseline>();
  // The newest observation per session and tab, which an action diffs against.
  const latestByScope = new Map<string, string>();
  const service = BrowserObservations.of({
    observe: Effect.fn("BrowserObservations.observe")(function* (namespace, snapshot, input) {
      const now = yield* Clock.currentTimeMillis;
      for (const [id, baseline] of baselines) {
        if (baseline.expiresAt <= now) baselines.delete(id);
      }
      const mode = input.mode ?? "compact";
      const maxChars = input.maxChars ?? 10_000;
      const scope = encode([namespace, snapshot.tabId]);
      const options = encode([mode, maxChars, input.includeDiagnostics === true]);
      const raw = semanticTree(snapshot, mode);
      let tree = boundedTree(raw, maxChars);
      const diagnostics =
        input.includeDiagnostics === true
          ? {
              console: snapshot.consoleEntries.slice(-8).map(({ level, text }) => ({
                level: level.slice(0, 32),
                text: text.slice(0, 200),
              })),
              network: snapshot.networkEntries.slice(-8).map(({ url, status, errorText }) => ({
                url: url.slice(0, 500),
                status,
                ...(errorText === undefined ? {} : { error: errorText.slice(0, 200) }),
              })),
              actions: snapshot.actionTimeline.slice(-8).map(({ action, status, error }) => ({
                action: action.slice(0, 100),
                status,
                ...(error === undefined ? {} : { error: error.slice(0, 200) }),
              })),
            }
          : undefined;
      if (diagnostics !== undefined) {
        while (Buffer.byteLength(encode(diagnostics), "utf8") > 6000) {
          const lists = [diagnostics.console, diagnostics.network, diagnostics.actions];
          const largest = lists.toSorted((a, b) => encode(b).length - encode(a).length)[0]!;
          largest.splice(0, Math.max(1, Math.floor(largest.length / 2)));
        }
      }
      const metadata = {
        url: boundedIdentity(snapshot.url, 2048, 4000),
        title: boundedIdentity(snapshot.title, 500, 1500),
        loading: snapshot.loading,
        ...(snapshot.tabId === undefined ? {} : { tabId: snapshot.tabId }),
        mode,
        ...(diagnostics === undefined ? {} : { diagnostics }),
      };
      while (
        tree.length > 0 &&
        Buffer.byteLength(encode({ ...metadata, tree }), "utf8") > MAX_BYTES - 1500
      ) {
        tree = boundedTree(tree, Math.floor(tree.length * 0.75));
      }
      const omitted = [
        ...(tree !== raw || snapshot.truncated === true
          ? [
              "tree truncated; increase maxChars, narrow with preview_evaluate, or inspect another region",
            ]
          : []),
        ...(input.includeDiagnostics
          ? ["diagnostics are bounded to recent entries and short text"]
          : []),
        ...(snapshot.url.length > 2048 || snapshot.title.length > 500
          ? ["page identity truncated"]
          : []),
      ];
      const snapshotId = `${epoch.slice(0, 8)}-${(++sequence).toString(36)}`;
      const baseline =
        input.since === undefined || snapshot.tabId === undefined
          ? undefined
          : baselines.get(input.since);
      let observation: Observation = {
        ...metadata,
        snapshotId,
        tree,
        ...(omitted.length === 0 ? {} : { omitted }),
      };
      if (baseline?.scope === scope && baseline.options === options) {
        if (baseline.tree === tree && baseline.metadata === encode(metadata)) {
          const { tree: _tree, ...rest } = observation;
          observation = { ...rest, baseSnapshotId: input.since!, unchanged: true };
        } else {
          const changes = patch(baseline.tree, tree);
          if (encode(changes).length + 70 < encode(tree).length) {
            const { tree: _tree, ...rest } = observation;
            observation = { ...rest, baseSnapshotId: input.since!, changes };
          }
        }
      }
      if (snapshot.tabId !== undefined) {
        baselines.delete(snapshotId);
        baselines.set(snapshotId, {
          scope,
          options,
          input: {
            ...(input.mode === undefined ? {} : { mode: input.mode }),
            ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
            ...(input.includeDiagnostics === undefined
              ? {}
              : { includeDiagnostics: input.includeDiagnostics }),
          },
          tree,
          metadata: encode(metadata),
          expiresAt: now + BASELINE_TTL_MS,
        });
        latestByScope.set(scope, snapshotId);
        while (baselines.size > MAX_BASELINES) baselines.delete(baselines.keys().next().value!);
        for (const [key, id] of latestByScope) {
          if (!baselines.has(id)) latestByScope.delete(key);
        }
      }
      return observation;
    }),
    observeActionChange: Effect.fn("BrowserObservations.observeActionChange")(
      function* (namespace, snapshot) {
        if (snapshot.tabId === undefined) return undefined;
        const scope = encode([namespace, snapshot.tabId]);
        const since = latestByScope.get(scope);
        const baseline = since === undefined ? undefined : baselines.get(since);
        if (since === undefined || baseline === undefined) return undefined;
        const observation = yield* service.observe(namespace, snapshot, {
          ...baseline.input,
          since,
        });
        const page = {
          url: observation.url,
          title: observation.title,
          loading: observation.loading,
        };
        if (observation.unchanged === true) {
          return {
            ...page,
            snapshotId: observation.snapshotId,
            baseSnapshotId: since,
            unchanged: true,
          };
        }
        if (
          observation.changes !== undefined &&
          encode(observation.changes).length <= MAX_ACTION_CHANGE_CHARS
        ) {
          return {
            ...page,
            snapshotId: observation.snapshotId,
            baseSnapshotId: since,
            changes: observation.changes,
          };
        }
        // The caller never sees this tree, so nothing may be diffed against it.
        baselines.delete(observation.snapshotId);
        latestByScope.set(scope, since);
        return { ...page, note: "The page changed a lot; take a snapshot to see it." };
      },
    ),
  });
  return service;
});

export const layer = Layer.effect(BrowserObservations, make);
