import { getSchemaByResolvedExtensions, Node, resolveExtensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState } from "@tiptap/pm/state";
import { expect, it } from "vite-plus/test";
import { composerGithubLinkPlugin } from "./composerGithubLink";
import { buildDocJson, serializeEditorDoc, serializeSelection } from "../composer-rich-text-doc";

const schema = getSchemaByResolvedExtensions(
  resolveExtensions([
    StarterKit,
    Node.create({
      name: "composer-github-link",
      inline: true,
      atom: true,
      group: "inline",
      addAttributes: () => ({ label: { default: "" }, source: { default: "" } }),
    }),
  ]),
);

it("waits through typed URLs, converts on whitespace, preserves the caret and deletes as one atom", () => {
  const url = "https://github.com/owner/repo/blob/main/src/file.ts?q=test#L1";
  let state = EditorState.create({ schema, plugins: [composerGithubLinkPlugin()] });
  for (const char of url) {
    state = state.applyTransaction(state.tr.insertText(char)).state;
    expect(state.doc.firstChild?.firstChild?.isText).toBe(true);
    expect(state.selection.from).toBe(1 + serializeEditorDoc(state.doc).value.length);
  }
  state = state.applyTransaction(state.tr.insertText(" ")).state;
  expect(state.doc.firstChild?.firstChild?.type.name).toBe("composer-github-link");
  expect(state.selection.from).toBe(3);
  expect(serializeEditorDoc(state.doc).value).toBe(`${url} `);
  expect(serializeSelection(state.doc, 1, 2)).toBe(url);
  state = state.apply(state.tr.delete(1, 2));
  expect(serializeEditorDoc(state.doc).value).toBe(" ");
});

it("restores a URL as an atom only once whitespace follows it", () => {
  const url = "https://github.com/owner/repo";
  const build = (value: string) =>
    schema.nodeFromJSON(buildDocJson(value, () => ({ label: "", description: null })));
  expect(build(url).firstChild?.firstChild?.isText).toBe(true);
  expect(build(`${url} `).firstChild?.firstChild?.type.name).toBe("composer-github-link");
  expect(serializeEditorDoc(build(`${url} `)).value).toBe(`${url} `);
});

it("keeps every typed doc equal to the doc its own prompt text restores", () => {
  // A mismatch moves the caret between the editor and the composer's cursor math forever.
  const text =
    "look at https://github.com/BetterWright/betterwright and\nhttps://github.com/a/b\nend";
  let state = EditorState.create({ schema, plugins: [composerGithubLinkPlugin()] });
  for (const char of text) {
    state = state.applyTransaction(
      char === "\n" ? state.tr.split(state.selection.from) : state.tr.insertText(char),
    ).state;
    const value = serializeEditorDoc(state.doc).value;
    const restored = schema.nodeFromJSON(
      buildDocJson(value, () => ({ label: "", description: null })),
    );
    expect(state.doc.eq(restored), JSON.stringify(value)).toBe(true);
  }
  expect(
    serializeEditorDoc(state.doc).runs.filter((run) => run.nodeName === "composer-github-link"),
  ).toHaveLength(2);
});
