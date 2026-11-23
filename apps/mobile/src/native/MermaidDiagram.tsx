import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { parse, SvgAst, type JsxAST, type XmlAST } from "react-native-svg";

import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { nativeMermaidSvg, type MermaidPalette } from "../lib/mermaidSvg";

export interface MermaidDiagram {
  readonly source: string;
  readonly ast: JsxAST;
  readonly width: number;
  readonly height: number;
}

type Pele = typeof import("pele");
let pele: Pele | undefined;
const renderedDiagrams = new Map<string, MermaidDiagram | null>();
const RENDERED_DIAGRAM_LIMIT = 64;

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

// react-native-svg draws text nodes verbatim, so `a &amp; b` would show its escape.
function decodeTextEntities(node: XmlAST): XmlAST {
  node.children = node.children.map((child) =>
    typeof child === "string"
      ? child.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => XML_ENTITIES[entity]!)
      : decodeTextEntities(child),
  );
  return node;
}

/** Returns null when the source is not a diagram Pele or react-native-svg can draw. */
export function renderMermaidDiagram(
  source: string,
  palette: MermaidPalette,
  authored: string,
): MermaidDiagram | null {
  const key = `${Object.values(palette).join("|")}\n${authored}`;
  const cached = renderedDiagrams.get(key);
  if (cached !== undefined) return cached;
  let diagram: MermaidDiagram | null = null;
  try {
    // Deferred so the renderer only loads once a thread actually contains a diagram.
    pele ??= require("pele") as Pele;
    // Links and images stay off: diagrams can come from untrusted PR descriptions.
    const result = pele.render(source, { links: false, images: false, autoDirection: false });
    const ast = parse(nativeMermaidSvg(result.svg, palette), decodeTextEntities);
    if (ast && result.width > 0 && result.height > 0)
      diagram = { source: authored, ast, width: result.width, height: result.height };
  } catch {
    // Unsupported or invalid diagrams stay readable as their code block.
  }
  if (renderedDiagrams.size >= RENDERED_DIAGRAM_LIMIT)
    renderedDiagrams.delete(renderedDiagrams.keys().next().value!);
  renderedDiagrams.set(key, diagram);
  return diagram;
}

export function MermaidDiagramView(props: {
  readonly diagram: MermaidDiagram;
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly foregroundColor: string;
}) {
  const { diagram } = props;
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Mermaid diagram"
        accessibilityHint="Tap to expand; touch and hold to copy the Markdown source"
        onPress={() => setExpanded(true)}
        onLongPress={() => copyTextWithHaptic(diagram.source, { target: "Mermaid source" })}
        style={{
          alignItems: "center",
          padding: 12,
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: props.borderColor,
          backgroundColor: props.backgroundColor,
        }}
      >
        {/* A known aspect ratio sizes the slot in one pass; wide diagrams scale down to fit. */}
        <View
          style={{
            width: "100%",
            maxWidth: diagram.width,
            aspectRatio: diagram.width / diagram.height,
          }}
        >
          <SvgAst
            ast={diagram.ast}
            override={{ width: "100%", height: "100%", accessible: false }}
          />
        </View>
      </Pressable>
      <Modal visible={expanded} onRequestClose={() => setExpanded(false)} animationType="fade">
        <View style={{ flex: 1, backgroundColor: props.backgroundColor, paddingTop: 56 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close diagram"
            onPress={() => setExpanded(false)}
            style={{ padding: 16, alignSelf: "flex-end" }}
          >
            <Text style={{ color: props.foregroundColor, fontSize: 18 }}>Close</Text>
          </Pressable>
          <ScrollView
            horizontal
            contentContainerStyle={{ flexGrow: 1 }}
            maximumZoomScale={4}
            minimumZoomScale={1}
          >
            <ScrollView
              contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}
              maximumZoomScale={4}
              minimumZoomScale={1}
            >
              <SvgAst
                ast={diagram.ast}
                override={{
                  width: Math.max(diagram.width, 320),
                  height: (Math.max(diagram.width, 320) * diagram.height) / diagram.width,
                  accessible: false,
                }}
              />
            </ScrollView>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
