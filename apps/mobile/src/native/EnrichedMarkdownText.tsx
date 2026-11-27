import { parseModelLinkHref } from "@t3tools/shared/modelLinks";
import { emojiMessageTypography } from "../lib/typography";
import { hasEmojiShortcode, isEmojiOnlyMessage } from "@t3tools/shared/emoji";
import { compactGithubMarkdownLinks } from "@t3tools/shared/githubLinks";
import { MARKDOWN_PLAIN_VALUE_PATTERN } from "@t3tools/shared/markdownPlainValues";
import { decodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextHref,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import {
  expandAbbreviatedInlineCodePaths,
  linkInlineCodeUrls,
} from "@t3tools/shared/markdownLinks";
import {
  markdownWithBlockImages,
  markdownWithHtml,
  markdownWithLiteralTildes,
  markdownWithMermaidDiagrams,
  markdownWithTableBreaks,
} from "../lib/markdownDocument";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { ActionSheetIOS, Alert, Platform, Share, StyleSheet, Text, View } from "react-native";
import {
  EnrichedMarkdownText,
  type DocumentAssetsEvent,
  type MarkdownStyle,
  type MarkdownMediaAsset,
} from "react-native-enriched-markdown";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";
import type { MessageMenuAction } from "./MessageMenuContext";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { AndroidAnchoredMenu } from "../components/AndroidAnchoredMenu";
import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { useEnrichedLinkVariants } from "./useEnrichedLinkVariants";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import { mayRenderMath } from "../lib/mathDetection";
import { MermaidDiagramView, renderMermaidDiagram } from "./MermaidDiagram";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { UserMessageDisclosure } from "./UserMessageDisclosure";
import { nativeSelectionOccurrence } from "../lib/assistantCitationSelection";
import { canMeasureUserMessageLines } from "./userMessageDisclosure.logic";
import {
  ENRICHED_INLINE_FILE_LINK_REGEX,
  enrichedTextLinkRegex,
  enrichedModelReference,
  enrichedModelDetails,
  enrichedLinkVariantPattern,
} from "../lib/enrichedLinkPresentation";

const MathBlockView = lazy(() =>
  import("./MathBlockView").then((module) => ({ default: module.MathBlockView })),
);

function enrichedStyle(
  style: SelectableMarkdownTextProps["textStyle"],
  dark: boolean,
  plainValues = false,
): MarkdownStyle {
  const monospace = Platform.OS === "ios" ? "Menlo" : "monospace";
  // Keep the radius modest: iOS clips square table-cell borders without stroking the corner arcs.
  const block = {
    marginTop: 4,
    marginBottom: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: style.dividerColor,
  };
  const body = {
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    marginTop: 0,
    marginBottom: 8,
  };
  const heading = (level: number) => {
    const fontSize = style.headingFontSizes?.[level - 1] ?? style.fontSize * (1.6 - level * 0.1);
    return {
      ...body,
      color: style.strongColor,
      fontFamily: style.headingFontFamily,
      fontSize,
      lineHeight: fontSize * 1.35,
      marginTop: 8,
    };
  };
  const code = {
    fontFamily: monospace,
    color: style.inlineCodeColor,
    backgroundColor: "transparent",
    borderColor: "transparent",
    fontSize: style.fontSize * 0.9,
    plainValuePattern: plainValues ? MARKDOWN_PLAIN_VALUE_PATTERN.source : "",
  };
  return {
    paragraph: body,
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    strong: { color: style.strongColor, fontFamily: style.boldFontFamily, fontWeight: "normal" },
    link: { color: style.linkColor, underline: false },
    code,
    codeBlock: {
      ...body,
      color: style.codeColor,
      backgroundColor: style.codeBlockBackgroundColor,
      fontFamily: monospace,
      fontSize: style.fontSize * 0.9,
      ...block,
      padding: 12,
      syntaxColors: dark
        ? {
            keyword: "#ff7b72",
            string: "#a5d6ff",
            number: "#79c0ff",
            constant: "#79c0ff",
            comment: "#8b949e",
            function: "#d2a8ff",
            type: "#ffa657",
            property: "#79c0ff",
            tag: "#7ee787",
            attribute: "#79c0ff",
          }
        : {
            keyword: "#cf222e",
            string: "#0a3069",
            number: "#0550ae",
            constant: "#0550ae",
            comment: "#6e7781",
            function: "#8250df",
            type: "#953800",
            property: "#0550ae",
            tag: "#116329",
            attribute: "#0550ae",
          },
    },
    blockquote: {
      ...body,
      color: style.mutedColor,
      backgroundColor: "transparent",
      borderColor: style.quoteMarkerColor,
      borderWidth: 2,
      gapWidth: 12,
    },
    list: { ...body, bulletColor: style.mutedColor, markerColor: style.mutedColor, gapWidth: 6 },
    thematicBreak: { color: style.dividerColor, height: 1, marginTop: 8, marginBottom: 8 },
    table: {
      ...body,
      ...block,
      headerFontFamily: style.boldFontFamily,
      headerTextColor: style.strongColor,
      headerBackgroundColor: style.codeBlockBackgroundColor,
      rowEvenBackgroundColor: "transparent",
      rowOddBackgroundColor: "transparent",
      cellPaddingHorizontal: 10,
      cellPaddingVertical: 7,
    },
    taskList: {
      checkedColor: style.linkColor,
      checkedTextColor: style.color,
      borderColor: style.mutedColor,
      checkedStrikethrough: false,
    },
  };
}

export function MobileEnrichedMarkdownText(
  props: SelectableMarkdownTextProps & {
    readonly messageActions?: ReadonlyArray<MessageMenuAction>;
  },
) {
  const { renderImage, resolveImageSource } = props;
  const sourceMarkdown = useMemo(() => markdownWithBlockImages(props.markdown), [props.markdown]);
  const [emoji, setEmoji] = useState<typeof import("@t3tools/shared/emojiMarkdown") | null>(null);
  const needsEmoji = hasEmojiShortcode(props.markdown);
  useEffect(() => {
    if (!needsEmoji || emoji) return;
    let active = true;
    import("@t3tools/shared/emojiMarkdown")
      .then((module) => {
        if (active) setEmoji(module);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [emoji, needsEmoji]);
  const [mathParser, setMathParser] = useState<typeof import("../lib/markdownMath") | null>(null);
  const [mathTypesetter, setMathTypesetter] = useState<typeof import("../lib/mathTypeset") | null>(
    null,
  );
  const mayContainMath = mayRenderMath(props.markdown, props.isStreaming ?? false);
  useEffect(() => {
    if (!mayContainMath || mathParser) return;
    let active = true;
    void import("../lib/markdownMath")
      .then((module) => {
        if (active) setMathParser(module);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [mayContainMath, mathParser]);
  const mathBlocks = useMemo(
    () =>
      mathParser && mayContainMath
        ? mathParser.findMathBlocks(
            sourceMarkdown,
            !!props.onLinkPress,
            {
              text: enrichedTextLinkRegex(props.skills, props.models),
              inlineCode: ENRICHED_INLINE_FILE_LINK_REGEX,
            },
            props.plainValues,
          )
        : [],
    [
      mathParser,
      mayContainMath,
      sourceMarkdown,
      props.onLinkPress,
      props.skills,
      props.models,
      props.plainValues,
    ],
  );
  useEffect(() => {
    if (!mathBlocks.length || mathTypesetter) return;
    let active = true;
    void import("../lib/mathTypeset")
      .then((module) => {
        if (active) setMathTypesetter(module);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [mathBlocks.length, mathTypesetter]);
  const { markdown: mathMarkdown, diagrams: mathDiagrams } = useMemo(
    () =>
      mathTypesetter && mathBlocks.length
        ? mathTypesetter.markdownWithTypesetMath(sourceMarkdown, mathBlocks)
        : {
            markdown: sourceMarkdown,
            diagrams: new Map<string, import("../lib/mathTypeset").TypesetMathBlock>(),
          },
    [sourceMarkdown, mathBlocks, mathTypesetter],
  );
  const emojiMarkdown = useMemo(
    () => (needsEmoji && emoji ? emoji.markdownWithEmoji(mathMarkdown) : mathMarkdown),
    [emoji, needsEmoji, mathMarkdown],
  );
  const emojiOnly = isEmojiOnlyMessage(emojiMarkdown);
  const { themeAppearance } = useAppearancePreferences();
  const mermaidPalette = useMemo(
    () => ({
      background: props.textStyle.codeBlockBackgroundColor,
      foreground: props.textStyle.color,
      muted: props.textStyle.mutedColor,
      surface: themeColorWithAlpha(props.textStyle.color, 0.08),
      surfaceAlt: themeColorWithAlpha(props.textStyle.color, 0.16),
      border: themeColorWithAlpha(props.textStyle.color, 0.28),
      accent: props.textStyle.linkColor,
      monoFontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    }),
    [props.textStyle],
  );
  const { markdown, diagrams } = useMemo(() => {
    const prepared = markdownWithLiteralTildes(
      markdownWithTableBreaks(
        markdownWithHtml(
          compactGithubMarkdownLinks(
            linkInlineCodeUrls(expandAbbreviatedInlineCodePaths(emojiMarkdown)),
          ),
        ),
      ),
    );
    return markdownWithMermaidDiagrams(prepared, (source, authored) =>
      renderMermaidDiagram(source, mermaidPalette, authored),
    );
  }, [emojiMarkdown, mermaidPalette]);
  const [documentAssets, setDocumentAssets] = useState<DocumentAssetsEvent["assets"]>([]);
  const onDocumentAssets = useCallback(({ assets }: DocumentAssetsEvent) => {
    setDocumentAssets((previous) =>
      previous.length === assets.length &&
      previous.every((asset, index) => {
        const next = assets[index]!;
        return (
          asset.id === next.id &&
          asset.kind === next.kind &&
          asset.url === next.url &&
          asset.altText === next.altText &&
          asset.title === next.title &&
          asset.placement === next.placement &&
          asset.eligible === next.eligible
        );
      })
        ? previous
        : assets,
    );
  }, []);
  const { linkVariants, linkPillContent } = useEnrichedLinkVariants(documentAssets, props);
  const linkRecognition = useMemo(
    () => ({
      text: enrichedTextLinkRegex(props.skills, props.models) ?? undefined,
      inlineCode: ENRICHED_INLINE_FILE_LINK_REGEX,
    }),
    [props.skills, props.models],
  );
  const [activeMenu, setActiveMenu] = useState<{
    url: string;
    menu: NonNullable<ReturnType<NonNullable<typeof props.fileContextMenu>>>;
  } | null>(null);
  const { fileContextMenu, onFileContextMenuAction, onLinkPress: openLink, models } = props;
  const onLinkPress = useCallback(
    (url: string) => {
      if (parseModelLinkHref(url)) return;
      const model = enrichedModelReference(url, models);
      if (model) Alert.alert(model.label, enrichedModelDetails(model));
      else openLink?.(url);
    },
    [models, openLink],
  );
  const modelContextMenu = useCallback(
    (url: string) => {
      const model = enrichedModelReference(url, models);
      return model
        ? {
            title: model.label,
            actions: [
              { id: "enriched-copy-link", title: "Copy model reference" },
              { id: "enriched-share-link", title: "Share model reference" },
            ],
          }
        : undefined;
    },
    [models],
  );
  const recognizedLinks = useMemo(() => {
    const pattern = enrichedTextLinkRegex(props.skills, props.models);
    return pattern ? [...new Set(markdown.match(new RegExp(pattern.source, "gu")) ?? [])] : [];
  }, [markdown, props.skills, props.models]);
  const performMenuAction = useCallback(
    (url: string, actionId: string) => {
      if (actionId === "enriched-open-link") onLinkPress?.(url);
      else if (actionId === "enriched-copy-link") copyTextWithHaptic(url);
      else if (actionId === "enriched-share-link") void Share.share({ message: url });
      else onFileContextMenuAction?.(url, actionId);
    },
    [onLinkPress, onFileContextMenuAction],
  );
  const linkContextMenuItems = useMemo(
    () =>
      Platform.OS === "ios"
        ? Object.fromEntries(
            [
              ...new Set([
                ...documentAssets
                  .filter((asset) => asset.kind === "link")
                  .map((asset) => asset.url),
                ...recognizedLinks,
              ]),
            ].map((url) => {
              const menu = modelContextMenu(url) ??
                fileContextMenu?.(url) ?? {
                  title: url,
                  actions: [
                    { id: "enriched-open-link", title: "Open link" },
                    { id: "enriched-copy-link", title: "Copy link" },
                    { id: "enriched-share-link", title: "Share link" },
                  ],
                };
              return [
                enrichedLinkVariantPattern(url),
                menu.actions.map((action) => ({
                  text: action.title,
                  disabled: "disabled" in action && action.disabled,
                  onPress: () => performMenuAction(url, action.id),
                })),
              ];
            }),
          )
        : undefined,
    [documentAssets, fileContextMenu, performMenuAction, modelContextMenu, recognizedLinks],
  );
  const { onCiteSelection, onAskAboutSelection, messageActions } = props;
  // Built per render like the message actions; the native view keys callbacks by title.
  const selectionMenuItems = [
    ...(onCiteSelection
      ? [
          {
            text: "Cite",
            icon: "text.quote",
            onPress: ({
              text,
              selection,
            }: {
              text: string;
              selection: { start: number; end: number };
            }) =>
              onCiteSelection({
                text,
                occurrence: nativeSelectionOccurrence(
                  markdown,
                  { text, ...selection },
                  {
                    isPill: (url) => Object.hasOwn(linkPillContent, url),
                    text: linkRecognition.text,
                    inlineCode: linkRecognition.inlineCode,
                  },
                ),
              }),
          },
        ]
      : []),
    ...(onAskAboutSelection
      ? [
          {
            text: "Side chat",
            icon: "bubble.left.and.bubble.right",
            onPress: ({ text }: { text: string }) => onAskAboutSelection(text),
          },
        ]
      : []),
    ...(messageActions?.map((action) => ({ ...action })) ?? []),
  ];
  const selectionClipboard = useMemo(() => {
    const fragment = decodeComposerContextFragment(props.contextClipboardFragment);
    if (!fragment) return undefined;
    const references = collectComposerContextReferences(props.markdown);
    const linkTextByUrl = Object.fromEntries(
      references.flatMap((reference) => {
        const record = fragment.records.find((entry) => entry.contextId === reference.contextId);
        return record
          ? [
              [
                formatComposerContextHref(reference.kind, reference.contextId),
                formatComposerContextReference({ ...reference, label: record.label }),
              ],
            ]
          : [];
      }),
    );
    return {
      linkTextByUrl,
      htmlAttributes: {
        "data-t3-context-fragment": encodeURIComponent(props.contextClipboardFragment!),
      },
      mimeTypes: { "app.t3.context-fragment": props.contextClipboardFragment! },
    };
  }, [props.contextClipboardFragment, props.markdown]);
  const markdownStyle = useMemo(
    () => ({
      ...enrichedStyle(
        emojiOnly
          ? { ...props.textStyle, ...emojiMessageTypography(props.textStyle) }
          : props.textStyle,
        themeAppearance === "dark",
        props.plainValues,
      ),
      linkVariants,
    }),
    [emojiOnly, props.textStyle, themeAppearance, props.plainValues, linkVariants],
  );
  const renderMedia = useCallback(
    (asset: MarkdownMediaAsset) => {
      const math = mathDiagrams.get(asset.url);
      if (math) {
        const fallback = (
          <Text
            selectable={!props.displayOnly}
            style={{ color: props.textStyle.color, fontSize: props.textStyle.fontSize }}
          >
            {math.source}
          </Text>
        );
        return (
          <RenderErrorBoundary resetKeys={[math.source]} renderFallback={() => fallback}>
            <Suspense fallback={fallback}>
              <MathBlockView
                key={`${math.source}\n${props.textStyle.color}\n${props.textStyle.fontSize}\n${props.textStyle.lineHeight}`}
                block={math}
                color={props.textStyle.color}
                fontSize={props.textStyle.fontSize}
                lineHeight={props.textStyle.lineHeight}
                linkColor={props.textStyle.linkColor}
                onLinkPress={props.onLinkPress}
                fontFamily={props.textStyle.fontFamily}
                preserveSoftBreaks={props.preserveSoftBreaks ?? false}
              />
            </Suspense>
          </RenderErrorBoundary>
        );
      }
      const diagram = diagrams.get(asset.url);
      if (diagram)
        return (
          <MermaidDiagramView
            diagram={diagram}
            backgroundColor={mermaidPalette.background}
            borderColor={props.textStyle.dividerColor}
            foregroundColor={props.textStyle.color}
          />
        );
      return (
        renderImage?.({
          href: asset.url,
          alt: asset.altText || null,
          title: asset.title || null,
        }) ?? null
      );
    },
    [
      renderImage,
      diagrams,
      mathDiagrams,
      props.textStyle.fontSize,
      props.textStyle.lineHeight,
      props.textStyle.linkColor,
      props.onLinkPress,
      props.textStyle.fontFamily,
      props.preserveSoftBreaks,
      mermaidPalette.background,
      props.textStyle.dividerColor,
      props.textStyle.color,
    ],
  );
  const resolveNativeImageSource = useCallback(
    (asset: MarkdownMediaAsset) =>
      diagrams.has(asset.url) || mathDiagrams.has(asset.url)
        ? null
        : (resolveImageSource?.({
            href: asset.url,
            alt: asset.altText || null,
            title: asset.title || null,
          }) ?? null),
    [resolveImageSource, diagrams, mathDiagrams],
  );
  const renderMarkdown = (openAndroidMenu?: () => void) => {
    const onLinkLongPress = props.fileContextMenu
      ? ({ url }: { url: string }) => {
          const menu = props.fileContextMenu?.(url) ?? {
            title: url,
            actions: [
              { id: "enriched-open-link", title: "Open link" },
              { id: "enriched-copy-link", title: "Copy link" },
            ],
          };
          const actions = menu.actions;
          if (Platform.OS === "ios") {
            ActionSheetIOS.showActionSheetWithOptions(
              {
                title: menu.title,
                options: [...actions.map((action) => action.title), "Cancel"],
                cancelButtonIndex: actions.length,
                disabledButtonIndices: actions.flatMap((action, index) =>
                  action.disabled ? [index] : [],
                ),
              },
              (index) => {
                const action = actions[index];
                if (action && !action.disabled) performMenuAction(url, action.id);
              },
            );
          } else {
            setActiveMenu({ url, menu });
            openAndroidMenu?.();
          }
        }
      : undefined;

    const renderNativeText = (lines?: number, measuring = false) => {
      const hasLineLimit = lines !== undefined;
      return (
        <EnrichedMarkdownText
          markdown={markdown}
          markdownStyle={markdownStyle}
          onDocumentAssets={hasLineLimit ? undefined : onDocumentAssets}
          renderMedia={
            !hasLineLimit && (renderImage || diagrams.size > 0 || mathDiagrams.size > 0)
              ? renderMedia
              : undefined
          }
          resolveImageSource={
            !hasLineLimit && (resolveImageSource || diagrams.size > 0 || mathDiagrams.size > 0)
              ? resolveNativeImageSource
              : undefined
          }
          onImagePress={
            props.onImagePress || props.onLinkPress
              ? ({ url }) => (props.onImagePress ?? props.onLinkPress)?.(url)
              : undefined
          }
          linkRecognition={linkRecognition}
          containerStyle={{ flexShrink: 1, minWidth: 0 }}
          flavor={hasLineLimit ? "commonmark" : "github"}
          numberOfLines={lines}
          ellipsizeMode={hasLineLimit ? "clip" : undefined}
          selectable={!props.displayOnly && !measuring}
          contextMenuItems={
            props.displayOnly || measuring || selectionMenuItems.length === 0
              ? undefined
              : selectionMenuItems
          }
          selectionClipboard={selectionClipboard}
          selectionColor={props.textStyle.selectionColor}
          selectionHandleColor={props.textStyle.selectionHandleColor}
          md4cFlags={{
            latexMath: false,
            hardSoftBreaks: props.preserveSoftBreaks ?? false,
            admonitions: true,
          }}
          enableTaskListItemToggle={false}
          enableCodeBlockWrapToggle
          spoilerOverlay="solid"
          onLinkPress={measuring ? undefined : ({ url }) => onLinkPress(url)}
          onLinkLongPress={measuring ? undefined : onLinkLongPress}
          linkContextMenuItems={measuring ? undefined : linkContextMenuItems}
          linkPillContent={linkPillContent}
        />
      );
    };

    return (
      <View
        style={{
          flexShrink: 1,
          minWidth: 0,
          marginTop: props.marginTop,
          marginBottom: props.marginBottom,
        }}
      >
        {props.userMessageDisclosure && canMeasureUserMessageLines(markdown) ? (
          <UserMessageDisclosure
            key={JSON.stringify([
              markdown,
              props.textStyle.fontSize,
              props.textStyle.lineHeight,
              props.textStyle.fontFamily,
            ])}
            {...props.userMessageDisclosure}
            renderText={renderNativeText}
            lineHeight={markdownStyle.paragraph?.lineHeight ?? props.textStyle.lineHeight}
          >
            {renderNativeText()}
          </UserMessageDisclosure>
        ) : (
          renderNativeText()
        )}
      </View>
    );
  };

  return Platform.OS === "android" && props.fileContextMenu ? (
    <AndroidAnchoredMenu
      title={activeMenu?.menu.title}
      actions={
        activeMenu?.menu.actions.map((action) => ({
          id: action.id,
          title: action.title,
          attributes: { disabled: action.disabled },
        })) ?? []
      }
      onPressAction={({ nativeEvent }) => {
        if (activeMenu) performMenuAction(activeMenu.url, nativeEvent.event);
      }}
      style={{ flexShrink: 1, minWidth: 0 }}
    >
      {renderMarkdown}
    </AndroidAnchoredMenu>
  ) : (
    renderMarkdown()
  );
}
