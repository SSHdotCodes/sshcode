import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import tailwindColors from "tailwindcss/colors";
import { parseSync } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

/**
 * Guards against Uniwind color utilities that name a color missing from the
 * mobile theme. Uniwind silently drops those classes, leaving text, surfaces,
 * borders, or symbol tints uncolored.
 *
 * The scan covers static strings in `className` and `tintColorClassName` JSX
 * props, including conditional/logical branches, plus static strings passed to
 * `cn(...)` and `clsx(...)`. Template literals containing `${}` are skipped
 * completely, including their static text: this test cannot tell which parts of
 * the interpolated result are classes. Move those strings to `cn(...)` when
 * they need this coverage.
 *
 * The scanner intentionally knows the non-color utilities that share color
 * prefixes (font sizes, text alignment, border widths/styles, gradients, and
 * SVG stroke widths) so those utilities do not need an allowlist.
 */

const SOURCE_ROOT = __dirname;
const GENERATED_THEME_PATH = NodePath.resolve(__dirname, "../generated-uniwind-themes.css");

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

type ClassContext = "className" | "tintColorClassName" | "cn/clsx";

interface ClassLiteral {
  readonly value: string;
  readonly start: number;
  readonly context: ClassContext;
}

interface ColorViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly token: string;
  readonly literal: string;
  readonly reason: string;
}

function asNode(value: unknown): AstNode | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as { type?: unknown; start?: unknown; end?: unknown };
  if (
    typeof candidate.type !== "string" ||
    typeof candidate.start !== "number" ||
    typeof candidate.end !== "number"
  ) {
    return null;
  }
  return candidate as AstNode;
}

function nodeProperty(node: AstNode, key: string): AstNode | null {
  return asNode(node[key]);
}

function nodeListProperty(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  if (!Array.isArray(value)) {
    return [];
  }
  const nodes: AstNode[] = [];
  for (const item of value) {
    const child = asNode(item);
    if (child !== null) {
      nodes.push(child);
    }
  }
  return nodes;
}

function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "range" || key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const child = asNode(item);
        if (child !== null) {
          walkAst(child, visit);
        }
      }
    } else {
      const child = asNode(value);
      if (child !== null) {
        walkAst(child, visit);
      }
    }
  }
}

function stringLiteralValue(node: AstNode): string | null {
  const value = node.value;
  return node.type === "Literal" && typeof value === "string" ? value : null;
}

function identifierName(node: AstNode): string | null {
  const value = node.name;
  return node.type === "Identifier" && typeof value === "string" ? value : null;
}

function jsxAttributeName(node: AstNode): string | null {
  const name = nodeProperty(node, "name");
  if (name === null || name.type !== "JSXIdentifier" || typeof name.name !== "string") {
    return null;
  }
  return name.name;
}

function staticTemplateValue(node: AstNode): string | null {
  if (nodeListProperty(node, "expressions").length > 0) {
    return null;
  }
  const quasi = nodeListProperty(node, "quasis")[0];
  const value = quasi?.value;
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const templateValue = value as { cooked?: unknown; raw?: unknown };
  if (typeof templateValue.cooked === "string") {
    return templateValue.cooked;
  }
  return typeof templateValue.raw === "string" ? templateValue.raw : null;
}

function isClassMergerCall(node: AstNode): boolean {
  if (node.type !== "CallExpression") {
    return false;
  }
  const callee = nodeProperty(node, "callee");
  const name = callee === null ? null : identifierName(callee);
  return name === "cn" || name === "clsx";
}

function scanClassLiterals(source: string, filename: string): ClassLiteral[] {
  const parsed = parseSync(filename, source);
  if (parsed.errors.length > 0) {
    throw new Error(
      `Could not parse ${filename}: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const program = asNode(parsed.program);
  if (program === null) {
    throw new Error(`Could not parse ${filename}: missing program`);
  }

  const literals: ClassLiteral[] = [];
  const seen = new Set<string>();
  const contextualMergerCalls = new Set<string>();

  const collect = (node: AstNode, value: string, context: ClassContext): void => {
    const key = `${node.start}:${context}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    literals.push({ value, start: node.start, context });
  };

  const scanExpression = (node: AstNode, context: ClassContext): void => {
    switch (node.type) {
      case "Literal": {
        const value = stringLiteralValue(node);
        if (value !== null) {
          collect(node, value, context);
        }
        return;
      }
      case "TemplateLiteral": {
        const value = staticTemplateValue(node);
        if (value !== null) {
          collect(node, value, context);
        }
        return;
      }
      case "ConditionalExpression": {
        const consequent = nodeProperty(node, "consequent");
        const alternate = nodeProperty(node, "alternate");
        if (consequent !== null) scanExpression(consequent, context);
        if (alternate !== null) scanExpression(alternate, context);
        return;
      }
      case "LogicalExpression": {
        const left = nodeProperty(node, "left");
        const right = nodeProperty(node, "right");
        if (left !== null) scanExpression(left, context);
        if (right !== null) scanExpression(right, context);
        return;
      }
      case "ParenthesizedExpression":
      case "ChainExpression":
      case "TSAsExpression":
      case "TSNonNullExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion": {
        const expression = nodeProperty(node, "expression");
        if (expression !== null) scanExpression(expression, context);
        return;
      }
      case "ArrayExpression": {
        for (const element of nodeListProperty(node, "elements")) {
          scanExpression(element, context);
        }
        return;
      }
      case "ObjectExpression": {
        // clsx object entries use keys as classes and values as truthiness.
        for (const property of nodeListProperty(node, "properties")) {
          if (property.type !== "Property" || property.computed === true) {
            continue;
          }
          const key = nodeProperty(property, "key");
          if (key === null) {
            continue;
          }
          const literal = stringLiteralValue(key);
          if (literal !== null) {
            collect(key, literal, context);
            continue;
          }
          const identifier = identifierName(key);
          if (identifier !== null) {
            collect(key, identifier, context);
          }
        }
        return;
      }
      case "SpreadElement": {
        const argument = nodeProperty(node, "argument");
        if (argument !== null) scanExpression(argument, context);
        return;
      }
      case "CallExpression": {
        if (isClassMergerCall(node)) {
          contextualMergerCalls.add(`${node.start}:${node.end}`);
          for (const argument of nodeListProperty(node, "arguments")) {
            scanExpression(argument, context);
          }
          return;
        }
        const callee = nodeProperty(node, "callee");
        const args = nodeListProperty(node, "arguments");
        if (
          callee !== null &&
          identifierName(callee) === "String" &&
          args.length === 1 &&
          args[0] !== undefined
        ) {
          scanExpression(args[0], context);
        }
        return;
      }
    }
  };

  walkAst(program, (node) => {
    if (node.type !== "JSXAttribute") {
      return;
    }
    const name = jsxAttributeName(node);
    if (name !== "className" && name !== "tintColorClassName") {
      return;
    }
    const context: ClassContext = name;
    const value = nodeProperty(node, "value");
    if (value === null) {
      return;
    }
    const literal = stringLiteralValue(value);
    if (literal !== null) {
      collect(value, literal, context);
      return;
    }
    if (value.type === "JSXExpressionContainer") {
      const expression = nodeProperty(value, "expression");
      if (expression !== null) {
        scanExpression(expression, context);
      }
    }
  });

  walkAst(program, (node) => {
    if (!isClassMergerCall(node) || contextualMergerCalls.has(`${node.start}:${node.end}`)) {
      return;
    }
    for (const argument of nodeListProperty(node, "arguments")) {
      scanExpression(argument, "cn/clsx");
    }
  });

  return literals;
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of NodeFS.readdirSync(dir)) {
    const filePath = NodePath.join(dir, entry);
    if (NodeFS.statSync(filePath).isDirectory()) {
      collectSourceFiles(filePath, out);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(filePath);
    }
  }
  return out;
}

function collectColorNames(value: unknown, prefix: string, output: Set<string>): void {
  if (typeof value === "string") {
    output.add(prefix);
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    collectColorNames(child, prefix === "" ? key : `${prefix}-${key}`, output);
  }
}

const generatedTheme = NodeFS.readFileSync(GENERATED_THEME_PATH, "utf8");
const themeColorNames = new Set<string>();
for (const match of generatedTheme.matchAll(/--color-([A-Za-z0-9_-]+)\s*:/g)) {
  themeColorNames.add(match[1]!);
}

const tailwindColorNames = new Set<string>();
collectColorNames(tailwindColors, "", tailwindColorNames);

const TEXT_SIZES = new Set([
  "3xs",
  "2xs",
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "5xl",
  "6xl",
  "7xl",
  "8xl",
  "9xl",
]);
const TEXT_NON_COLORS = new Set([
  "left",
  "center",
  "right",
  "justify",
  "start",
  "end",
  "wrap",
  "nowrap",
  "balance",
  "pretty",
]);
const BORDER_SIDES = new Set(["x", "y", "s", "e", "t", "r", "b", "l"]);
const BORDER_STYLES = new Set([
  "solid",
  "dashed",
  "dotted",
  "double",
  "hidden",
  "none",
  "continuous",
  "collapse",
  "separate",
]);
const BACKGROUND_NON_COLORS = new Set([
  "fixed",
  "local",
  "scroll",
  "bottom",
  "center",
  "left",
  "left-bottom",
  "left-top",
  "right",
  "right-bottom",
  "right-top",
  "top",
  "repeat",
  "no-repeat",
  "auto",
  "cover",
  "contain",
  "none",
]);
const COLOR_UTILITY_PATTERN = /^(bg|text|border|divide|ring|fill|stroke|accent|from|via|to)(?:-|$)/;

interface InvalidColorUtility {
  readonly token: string;
  readonly colorName: string;
  readonly prefix: string;
}

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "[" || char === "(") {
      depth += 1;
    } else if (char === "]" || char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === separator && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function utilityName(token: string): string {
  let normalized = token;
  if (normalized.startsWith("!")) {
    normalized = normalized.slice(1);
  }
  if (normalized.endsWith("!")) {
    normalized = normalized.slice(0, -1);
  }
  const parts = splitTopLevel(normalized, ":");
  return parts[parts.length - 1] ?? normalized;
}

function opacityColorPart(rest: string): string {
  return splitTopLevel(rest, "/")[0] ?? rest;
}

function isArbitrary(value: string): boolean {
  return value.startsWith("[") || value.startsWith("(");
}

function isNumericUtility(value: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(value);
}

function borderColorCandidate(base: string): string | null {
  if (BORDER_STYLES.has(base) || BORDER_SIDES.has(base) || isNumericUtility(base)) {
    return null;
  }
  const firstDash = base.indexOf("-");
  if (firstDash > 0) {
    const side = base.slice(0, firstDash);
    const remainder = base.slice(firstDash + 1);
    if (BORDER_SIDES.has(side)) {
      if (remainder === "" || isNumericUtility(remainder) || isArbitrary(remainder)) {
        return null;
      }
      return remainder;
    }
  }
  return isArbitrary(base) ? null : base;
}

function divideColorCandidate(base: string): string | null {
  if (base === "reverse" || base === "x" || base === "y" || BORDER_STYLES.has(base)) {
    return null;
  }
  const firstDash = base.indexOf("-");
  if (firstDash > 0) {
    const axis = base.slice(0, firstDash);
    const remainder = base.slice(firstDash + 1);
    if (
      (axis === "x" || axis === "y") &&
      (remainder === "reverse" || isNumericUtility(remainder) || isArbitrary(remainder))
    ) {
      return null;
    }
  }
  return isArbitrary(base) || isNumericUtility(base) ? null : base;
}

function invalidColorUtility(token: string): InvalidColorUtility | null {
  const utility = utilityName(token);
  const match = COLOR_UTILITY_PATTERN.exec(utility);
  if (match === null) {
    return null;
  }
  const prefix = match[1]!;
  const restWithDash = utility.slice(prefix.length);
  if (!restWithDash.startsWith("-")) {
    return null;
  }
  const rest = restWithDash.slice(1);
  if (rest === "" || isArbitrary(rest)) {
    return null;
  }
  const base = opacityColorPart(rest);
  if (base === "" || isArbitrary(base)) {
    return null;
  }

  let colorName: string | null = base;
  if (prefix === "text") {
    if (TEXT_SIZES.has(rest) || TEXT_SIZES.has(base) || TEXT_NON_COLORS.has(base)) {
      return null;
    }
    if (base.startsWith("shadow-") || base.startsWith("stroke-")) {
      return null;
    }
  } else if (prefix === "bg") {
    if (
      BACKGROUND_NON_COLORS.has(base) ||
      base.startsWith("linear-") ||
      base.startsWith("gradient-") ||
      base.startsWith("radial") ||
      base.startsWith("conic") ||
      base.startsWith("repeat-") ||
      base.startsWith("clip-") ||
      base.startsWith("origin-") ||
      base.startsWith("blend-")
    ) {
      return null;
    }
  } else if (prefix === "border") {
    colorName = borderColorCandidate(base);
  } else if (prefix === "divide") {
    colorName = divideColorCandidate(base);
  } else if (prefix === "ring") {
    if (base === "inset" || isNumericUtility(base) || isArbitrary(base)) {
      return null;
    }
    if (base.startsWith("offset-")) {
      const offset = base.slice("offset-".length);
      colorName = isNumericUtility(offset) || isArbitrary(offset) ? null : offset;
    }
  } else if (prefix === "stroke" && isNumericUtility(base)) {
    return null;
  }

  if (
    colorName === null ||
    ((prefix === "fill" || prefix === "stroke") && colorName === "none") ||
    themeColorNames.has(colorName) ||
    tailwindColorNames.has(colorName)
  ) {
    return null;
  }
  return { token, colorName, prefix };
}

function createPositionLookup(
  source: string,
): (offset: number) => { line: number; column: number } {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }
  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle]! <= offset) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const lineIndex = Math.max(0, high);
    return { line: lineIndex + 1, column: offset - lineStarts[lineIndex]! + 1 };
  };
}

interface SourceAudit {
  readonly violations: ColorViolation[];
  readonly literalCount: number;
}

function auditSource(source: string, filePath: string, displayedFile: string): SourceAudit {
  const positionAt = createPositionLookup(source);
  const violations: ColorViolation[] = [];
  const literals = scanClassLiterals(source, filePath);
  for (const literal of literals) {
    for (const token of literal.value.split(/\s+/)) {
      if (token === "") {
        continue;
      }
      const position = positionAt(literal.start);
      const invalid = invalidColorUtility(token);
      if (invalid !== null) {
        violations.push({
          file: displayedFile,
          line: position.line,
          column: position.column,
          token,
          literal: literal.value,
          reason: `unknown color "${invalid.colorName}" in ${invalid.prefix}- utility`,
        });
      }
      if (literal.context === "tintColorClassName") {
        const utility = utilityName(token);
        if (utility !== "" && !utility.startsWith("accent-")) {
          violations.push({
            file: displayedFile,
            line: position.line,
            column: position.column,
            token,
            literal: literal.value,
            reason: "tintColorClassName must use accent-<color>",
          });
        }
      }
    }
  }
  return { violations, literalCount: literals.length };
}

function violationsForSource(source: string, filePath: string, displayedFile: string) {
  return auditSource(source, filePath, displayedFile).violations;
}

function auditFile(filePath: string): SourceAudit {
  return auditSource(
    NodeFS.readFileSync(filePath, "utf8"),
    filePath,
    NodePath.relative(SOURCE_ROOT, filePath),
  );
}

describe("mobile Uniwind theme color classes", () => {
  it("uses only theme or Tailwind colors in scanned class literals", () => {
    const files = collectSourceFiles(SOURCE_ROOT);
    const audits = files.map(auditFile);
    const violations = audits.flatMap((audit) => audit.violations);
    const literalCount = audits.reduce((count, audit) => count + audit.literalCount, 0);
    const formatted = violations.map(
      (violation) =>
        `${violation.file}:${violation.line}:${violation.column} ${violation.token} — ${violation.reason} (in ${JSON.stringify(violation.literal)})`,
    );

    // The counts keep this audit from passing vacuously if parsing or extraction regresses.
    expect(files.length).toBeGreaterThan(1000);
    expect(literalCount).toBeGreaterThan(3000);
    expect(formatted).toEqual([]);
  });

  it("scans only class-producing branches and enforces accent tints", () => {
    const fixture = `
      export function Fixture(props: { tone: string; active: boolean; dynamic: string }) {
        return (
          <>
            <View
              className={cn(
                "bg-card",
                props.tone === "bg-not-a-color" ? "text-link" : "text-foreground",
                clsx({ "bg-background": props.active }),
              )}
            />
            <SymbolView tintColorClassName={props.active ? "foreground" : "accent-icon"} />
            <SymbolView tintColorClassName={String("accent-icon-muted")} />
            <View className={\`bg-sheet \${props.dynamic} text-foreground-subtle\`} />
          </>
        );
      }
    `;
    const violations = violationsForSource(fixture, "fixture.tsx", "fixture.tsx");

    expect(violations.map((violation) => [violation.token, violation.reason])).toEqual([
      ["text-link", 'unknown color "link" in text- utility'],
      ["bg-background", 'unknown color "background" in bg- utility'],
      ["foreground", "tintColorClassName must use accent-<color>"],
    ]);
  });

  it("distinguishes unknown colors from sizes, widths, gradients, and built-ins", () => {
    expect(invalidColorUtility("text-foreground-subtle")?.colorName).toBe("foreground-subtle");
    expect(invalidColorUtility("text-link")?.colorName).toBe("link");
    expect(invalidColorUtility("bg-background")?.colorName).toBe("background");
    expect(invalidColorUtility("text-muted-foreground")?.colorName).toBe("muted-foreground");
    expect(invalidColorUtility("bg-accent-icon-muted")?.colorName).toBe("accent-icon-muted");

    for (const valid of [
      "text-foreground-muted",
      "text-md-link",
      "bg-sheet",
      // oxlint-disable-next-line t3code/no-mobile-uniwind-theme-escape-hatches -- Fixture proves variant stripping; it is not shipped styling.
      "dark:text-foreground-tertiary",
      "active:bg-danger-foreground/10",
      "android:border-t-primary",
      "ios:accent-icon-muted",
      "bg-red-500",
      "text-white/80",
      "text-3xs",
      "text-sm/6",
      "text-center",
      "border",
      "border-b",
      "border-l-[3px]",
      "border-continuous",
      "divide-x",
      "divide-x-[3px]",
      "ring-2",
      "stroke-2",
      "fill-none",
      "bg-linear-to-r",
      "bg-[#27272a]",
      "from-sheet",
      "to-transparent",
    ]) {
      expect(invalidColorUtility(valid), valid).toBeNull();
    }
  });
});
