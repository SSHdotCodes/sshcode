import type { Plugin } from "vite-plus";

const ZXCVBN_DICTIONARY_MODULE_HEADER =
  /(\w+)\.r\((\w+)\),\1\.d\(\2,\{adjacencyGraphs:\(\)=>\w+,dictionary:\(\)=>\w+\}\);let \w+=\{diceware:"/;

/**
 * `@clerk/clerk-js` inlines `@zxcvbn-ts/language-common` (~465 KB of common
 * English words, first names, and leaked passwords) into its ESM bundle for
 * client-side password-strength hints. Replacing that module body with empty
 * dictionaries shrinks the Electron auth chunk and keeps bundled word lists
 * out of the packaged app while keeping `zxcvbn` callable.
 */
export function stripClerkZxcvbnDictionary(code: string): string {
  const match = ZXCVBN_DICTIONARY_MODULE_HEADER.exec(code);
  if (!match) return code;

  const openBrace = code.lastIndexOf("{", match.index);
  if (openBrace < 0) return code;

  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  let closeBrace = -1;

  for (let i = openBrace; i < code.length; i++) {
    const ch = code[i];
    if (inString !== null) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }

  if (closeBrace < 0) return code;

  const [, webpackRequire, moduleExports] = match;
  const stub = `{${webpackRequire}.r(${moduleExports}),${webpackRequire}.d(${moduleExports},{adjacencyGraphs:()=>({}),dictionary:()=>({})})}`;
  return `${code.slice(0, openBrace)}${stub}${code.slice(closeBrace + 1)}`;
}

export function stripClerkZxcvbnDictionaryPlugin(): Plugin {
  return {
    name: "t3code:strip-clerk-zxcvbn-dictionary",
    transform(code, id) {
      const normalized = id.replaceAll("\\", "/");
      if (!normalized.includes("@clerk/clerk-js/dist/")) return null;
      const stripped = stripClerkZxcvbnDictionary(code);
      return stripped === code ? null : { code: stripped, map: null };
    },
  };
}
