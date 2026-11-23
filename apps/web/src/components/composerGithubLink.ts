import { collectGithubLinks } from "@t3tools/shared/githubLinks";
import { Plugin, type EditorState } from "@tiptap/pm/state";

const LINK_CHIP_HOSTS = ["github.com", "huggingface.co", "hf.co"];

import { serializeEditorDoc } from "~/composer-rich-text-doc";

/**
 * Turns finished GitHub and Hugging Face URLs into chips by the composer's own rule: the prompt
 * text this doc serializes to is parsed exactly as the composer parses it, so
 * a URL becomes a chip here only where the prompt's parse makes one.
 */
function githubLinkTransaction(state: EditorState) {
  const type = state.schema.nodes["composer-github-link"];
  const text = state.doc.textContent;
  if (!type || !LINK_CHIP_HOSTS.some((host) => text.includes(host))) return null;
  const map = serializeEditorDoc(state.doc);
  const tr = state.tr;
  for (const match of collectGithubLinks(map.value, false)) {
    const run = map.runs.find(
      (candidate) =>
        candidate.kind === "text" &&
        candidate.mdStart + candidate.openLen <= match.start &&
        match.end <= candidate.mdStart + candidate.mdLen - candidate.closeLen,
    );
    if (!run) continue;
    const from = run.pmPos + match.start - run.mdStart - run.openLen;
    const to = from + match.source.length;
    const $from = state.doc.resolve(from);
    if ($from.parent.type.spec.code || state.doc.textBetween(from, to) !== match.source) continue;
    tr.replaceWith(
      tr.mapping.map(from),
      tr.mapping.map(to),
      type.create(
        { source: match.source, label: match.label },
        null,
        state.doc.nodeAt(from)?.marks ?? [],
      ),
    );
  }
  return tr.docChanged ? tr : null;
}

/** A URL being typed stays text until whitespace follows it; a pasted one arrives spaced. */
export function composerGithubLinkPlugin() {
  return new Plugin({
    appendTransaction(transactions, _, state) {
      return transactions.some((tr) => tr.docChanged) ? githubLinkTransaction(state) : null;
    },
  });
}
