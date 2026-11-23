// @effect-diagnostics nodeBuiltinImport:off - compiles real source files from disk.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

import { expect, it } from "vite-plus/test";

/**
 * Components and hooks that must compile under the React Compiler. The compiler skips a whole
 * function without a word when it meets syntax it cannot lower (`try/finally`, `throw` inside
 * `try`, `||=`) or a rule break (a ref read or written during render, a memo whose dependency
 * list is wrong), so a skip goes unseen until this fails.
 */
const MUST_COMPILE: ReadonlyArray<readonly [file: string, functions: ReadonlyArray<string>]> = [
  ["components/chat/ProviderModelPicker.tsx", ["ProviderModelPicker"]],
  ["components/chat/ModelPickerContent.tsx", ["ModelPickerContent"]],
  ["components/chat/ChatHeader.tsx", ["ChatHeader"]],
  ["components/Sidebar.tsx", ["SidebarThreadRow", "SidebarSearchResultRow"]],
];

type CompilerEvent = {
  readonly kind: string;
  readonly fnName?: string | null;
  readonly fnLoc?: { readonly start: { readonly line: number } } | null;
  readonly detail?: {
    readonly reason?: string;
    readonly options?: { readonly reason?: string };
  };
};

const require = NodeModule.createRequire(import.meta.url);
// The Vite config runs the compiler through this Babel plugin host; `@babel/core` is its peer.
const babel = NodeModule.createRequire(require.resolve("@rolldown/plugin-babel"))(
  "@babel/core",
) as typeof import("@babel/core");

it.each(MUST_COMPILE)(
  "%s compiles under the React Compiler",
  (file, functions) => {
    const path = NodeURL.fileURLToPath(new URL(file, import.meta.url));
    const compiled = new Set<string>();
    const skipped: string[] = [];
    babel.transformSync(NodeFS.readFileSync(path, "utf8"), {
      filename: path,
      babelrc: false,
      configFile: false,
      code: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
      plugins: [
        [
          require.resolve("babel-plugin-react-compiler"),
          {
            logger: {
              logEvent(_filename: string | null, event: CompilerEvent) {
                if (event.kind === "CompileSuccess" && event.fnName) compiled.add(event.fnName);
                if (event.kind === "CompileError") {
                  const reason = event.detail?.options?.reason ?? event.detail?.reason;
                  skipped.push(`function at line ${event.fnLoc?.start.line}: ${reason}`);
                }
              },
            },
          },
        ],
      ],
    });
    const missing = functions.filter((name) => !compiled.has(name));
    // On failure, show why the compiler skipped what it skipped in this file.
    expect({ missing, skipped: missing.length > 0 ? skipped : [] }).toEqual({
      missing: [],
      skipped: [],
    });
  },
  120_000,
);
