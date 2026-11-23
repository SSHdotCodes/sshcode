import { Plugin, type EditorState } from "@tiptap/pm/state";
import { collectComposerPromptInlineTokens } from "~/composer-editor-mentions";
import { serializeEditorDoc } from "~/composer-rich-text-doc";

export function modelMentionTransaction(
  state: EditorState,
  exists: (instanceId: string, model: string) => boolean,
) {
  const type = state.schema.nodes["composer-model"];
  if (!type) return null;
  const tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (
      node.type === type &&
      !String(node.attrs.source).startsWith("[") &&
      !exists(String(node.attrs.instanceId), String(node.attrs.model))
    ) {
      tr.replaceWith(
        tr.mapping.map(pos),
        tr.mapping.map(pos + node.nodeSize),
        state.schema.text(String(node.attrs.source), node.marks),
      );
    }
  });
  const map = serializeEditorDoc(state.doc);
  for (const mention of collectComposerPromptInlineTokens(map.value)) {
    if (
      mention.type !== "model" ||
      (!mention.source.startsWith("[") && !exists(mention.instanceId, mention.model))
    )
      continue;
    const run = map.runs.find(
      (candidate) =>
        candidate.kind === "text" &&
        candidate.mdStart + candidate.openLen <= mention.start &&
        mention.end <= candidate.mdStart + candidate.mdLen - candidate.closeLen,
    );
    if (!run) continue;
    const from = run.pmPos + mention.start - run.mdStart - run.openLen;
    const to = from + mention.source.length;
    if (
      state.doc.resolve(from).parent.type.spec.code ||
      state.doc.textBetween(from, to) !== mention.source
    )
      continue;
    tr.replaceWith(
      tr.mapping.map(from),
      tr.mapping.map(to),
      type.create(
        { instanceId: mention.instanceId, model: mention.model, source: mention.source },
        null,
        state.doc.nodeAt(from)?.marks,
      ),
    );
  }
  return tr.docChanged ? tr : null;
}

export function composerModelPlugin(exists: (instanceId: string, model: string) => boolean) {
  return new Plugin({
    appendTransaction(transactions, _, state) {
      return transactions.some((tr) => tr.docChanged)
        ? modelMentionTransaction(state, exists)
        : null;
    },
  });
}
