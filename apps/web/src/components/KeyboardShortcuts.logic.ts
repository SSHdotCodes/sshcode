import type {
  KeybindingCommand,
  KeybindingShortcut,
  KeybindingWhenNode,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { formatShortcutLabel, shortcutConflictKey, type ShortcutEventLike } from "../keybindings";
import { normalizeSearchText } from "../lib/utils";
import {
  commandLabel,
  shortcutToKeybindingInput,
  whenAstToExpression,
} from "./settings/KeybindingsSettings.logic";

export interface KeyboardShortcutRow {
  readonly id: string;
  readonly command: KeybindingCommand;
  readonly label: string;
  readonly shortcut: KeybindingShortcut;
  readonly when: string;
}

/** A client-only help chord yields to every configured command. */
export function isKeyboardShortcutsHelpEvent(event: ShortcutEventLike, platform: string): boolean {
  return (
    event.shiftKey &&
    !event.altKey &&
    (isMacPlatform(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    (event.code === "Slash" || event.key === "?" || event.key === "/")
  );
}

// Only the client surface is fixed. Contexts such as terminalFocus remain
// visible with their condition, even when the reference itself owns focus.
function surfaceAllows(node: KeybindingWhenNode | undefined, isDesktop: boolean): boolean | null {
  if (!node) return true;
  switch (node.type) {
    case "identifier":
      return node.name === "isDesktop"
        ? isDesktop
        : node.name === "isWeb"
          ? !isDesktop
          : node.name === "true"
            ? true
            : node.name === "false"
              ? false
              : null;
    case "not": {
      const value = surfaceAllows(node.node, isDesktop);
      return value === null ? null : !value;
    }
    case "and": {
      const left = surfaceAllows(node.left, isDesktop);
      const right = surfaceAllows(node.right, isDesktop);
      return left === false || right === false
        ? false
        : left === true && right === true
          ? true
          : null;
    }
    case "or": {
      const left = surfaceAllows(node.left, isDesktop);
      const right = surfaceAllows(node.right, isDesktop);
      return left === true || right === true
        ? true
        : left === false && right === false
          ? false
          : null;
    }
  }
}

export function buildKeyboardShortcutGroups(input: {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly platform: string;
  readonly isDesktop: boolean;
  readonly query: string;
}) {
  const groups = new Map<string, KeyboardShortcutRow[]>();
  const claimed = new Set<string>();
  const unconditional = new Set<string>();
  const tokens = normalizeSearchText(input.query).split(" ").filter(Boolean);
  for (let index = input.keybindings.length - 1; index >= 0; index -= 1) {
    const binding = input.keybindings[index];
    if (!binding || surfaceAllows(binding.whenAst, input.isDesktop) === false) continue;
    const key = shortcutConflictKey(binding.shortcut, input.platform);
    const when = whenAstToExpression(binding.whenAst);
    const contextKey = `${key}\u0000${when}`;
    if (unconditional.has(key) || claimed.has(contextKey)) continue;
    claimed.add(contextKey);
    if (surfaceAllows(binding.whenAst, input.isDesktop) === true) unconditional.add(key);

    const label = commandLabel(binding.command);
    const group = label.includes(":") ? label.slice(0, label.indexOf(":")) : "Navigation";
    const search = normalizeSearchText(
      [
        label,
        binding.command,
        when,
        formatShortcutLabel(binding.shortcut, input.platform),
        shortcutToKeybindingInput(binding.shortcut),
      ].join(" "),
    );
    if (!tokens.every((token) => search.includes(token))) continue;
    const row = {
      id: `${binding.command}:${index}`,
      command: binding.command,
      label,
      shortcut: binding.shortcut,
      when,
    };
    const rows = groups.get(group);
    if (rows) rows.push(row);
    else groups.set(group, [row]);
  }
  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, rows]) => ({
      label,
      rows: rows.sort((left, right) => left.label.localeCompare(right.label)),
    }));
}
