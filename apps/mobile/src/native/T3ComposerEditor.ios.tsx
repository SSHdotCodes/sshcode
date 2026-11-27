import { useComposerModelTokens } from "./useComposerModelTokens";
import { modelChipIconUri } from "../lib/contextChipIconSource";
import { PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES } from "@t3tools/client-runtime/text-paste";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { collectComposerLinkTokens, composerContextEditorTokens } from "../lib/composerContext";
import { linkChipIconUri } from "../lib/contextChipIconSource";
import { requireNativeView } from "expo";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import type { NativeSyntheticEvent, StyleProp, ViewProps, ViewStyle } from "react-native";
import { StyleSheet, useWindowDimensions } from "react-native";
import { composerEditorHeight } from "./composerEditorLayout";

import { markdownFileIconSource, markdownIconAssetUri } from "../lib/markdownFileIcons";
import { composerChipSizeSuffix, contextChipPresentation } from "../lib/composerChipPresentation";
import { resolveMarkdownFileIcon } from "../lib/markdownLinks";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import { createNativeComposerTheme } from "../lib/nativeComposerTheme";
import { flattenThemeColor } from "../lib/mobileTheme";
import { useFontFamily } from "../lib/useFontFamily";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import {
  acknowledgeComposerNativeEvent,
  assumeComposerControlledState,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
  type ComposerNativeEventSnapshot,
} from "./composerEditorRevision";
import { DEFAULT_COMPOSER_ENTER_BEHAVIOR } from "../lib/composerEnterBehavior";
import type { ComposerEditorProps, ComposerEditorSelection } from "./T3ComposerEditor.types";

const NATIVE_MODULE_NAME = "T3ComposerEditor";
/** How long events from before a reset are dropped, in case the editor never confirms it. */
const RESET_GRACE_MS = 2_000;
const EMPTY_MODELS: NonNullable<ComposerEditorProps["models"]> = [];
const EMPTY_SKILLS: NonNullable<ComposerEditorProps["skills"]> = [];

type NativeEditorEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly eventCount: number;
  /** The last reset the editor had applied when it sent this event. */
  readonly resetSequence?: number;
  /** The editor confirming a reset it applied, not the user typing. */
  readonly resetAck?: boolean;
}>;

type NativeSelectionEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly eventCount: number;
  readonly resetSequence?: number;
}>;

type NativePasteImagesEvent = NativeSyntheticEvent<{
  readonly uris: ReadonlyArray<string>;
}>;

type NativePasteTextEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly eventCount: number;
  readonly text: string;
  readonly selection: ComposerEditorSelection;
  readonly resetSequence?: number;
}>;

interface NativeComposerEditorRef {
  focus: () => Promise<void>;
  blur: () => Promise<void>;
  setSelection: (start: number, end: number) => Promise<void>;
  readState: () => Promise<{
    readonly value: string;
    readonly selection: ComposerEditorSelection;
    readonly eventCount: number;
    readonly resetSequence: number;
    readonly pasteEventCount: number;
  }>;
}

interface NativeComposerEditorProps extends ViewProps {
  readonly ref?: Ref<NativeComposerEditorRef>;
  readonly controlledDocumentJson: string;
  readonly clipboardFragment: string;
  readonly themeJson: string;
  readonly placeholder: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly contentInsetVertical: number;
  readonly editable: boolean;
  readonly readOnly: boolean;
  readonly enterBehavior: string;
  readonly submitTitle: string;
  readonly alternateSubmitTitle: string;
  readonly scrollEnabled: boolean;
  readonly autoFocus: boolean;
  readonly autoCorrect: boolean;
  readonly spellCheck: boolean;
  readonly onComposerContentSizeChange?: (
    event: NativeSyntheticEvent<{ width: number; height: number }>,
  ) => void;
  readonly onComposerChange: (event: NativeEditorEvent) => void;
  readonly onComposerSelectionChange?: (event: NativeSelectionEvent) => void;
  readonly onComposerPasteImages?: (event: NativePasteImagesEvent) => void;
  readonly onComposerContextPress?: (
    event: NativeSyntheticEvent<{ source: string; start: number; end: number }>,
  ) => void;
  readonly onComposerPasteContext?: (
    event: NativePasteTextEvent & NativeSyntheticEvent<{ fragment: string; html: string }>,
  ) => void;
  readonly textPasteThresholdBytes: number;
  readonly maxInputChars: number;
  readonly onComposerPasteText?: (event: NativePasteTextEvent) => void;
  readonly onComposerFocus?: () => void;
  readonly onComposerBlur?: () => void;
  readonly onComposerSubmit?: (event: NativeSyntheticEvent<{ alternate: boolean }>) => void;
}

const NativeView = requireNativeView<NativeComposerEditorProps>(NATIVE_MODULE_NAME);

// Fabric does not mount a `display: none` subtree, so a command sent while the composer slot is
// hidden (an open question) rejects with "Unable to find the view". There is nothing to act on.
function settleViewCommand(command: Promise<void> | undefined): void {
  command?.catch(() => undefined);
}

function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

/** A citation chip wears the composer's accent, the colour of its send button. */
function citationChipAccent(theme: ReturnType<typeof useUniwindTheme>): string {
  return flattenThemeColor(
    theme["--color-primary"],
    flattenThemeColor(theme["--color-composer-surface"], theme["--color-screen"]),
  );
}

function fileIconUri(path: string): string | null {
  return markdownIconAssetUri(markdownFileIconSource(resolveMarkdownFileIcon(path))) ?? null;
}

export function ComposerEditor({
  ref,
  skills = EMPTY_SKILLS,
  models = EMPTY_MODELS,
  selection,
  style,
  textStyle,
  onChangeText,
  onSelectionChange,
  onPasteImages,
  onPasteText,
  onFocus,
  onBlur,
  onSubmit,
  contentInsetVertical = 0,
  readResetGeneration,
  ...props
}: ComposerEditorProps) {
  const nativeRef = useRef<NativeComposerEditorRef>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const { fontScale } = useWindowDimensions();
  const mostRecentEventCountRef = useRef(0);
  const [mostRecentEventCount, setMostRecentEventCount] = useState(0);
  const [, forceNativeEventRender] = useState(0);
  // The native editor mounts empty, so the snapshot history starts empty: the
  // first controlled payload must be a non-echo so a restored draft (or a
  // recycled native view) is applied rather than skipped.
  const nativeEventSnapshotsRef = useRef<ComposerNativeEventSnapshot[]>([]);
  // The parent emptying text it had in sync with the editor (the clear after sending) is a
  // reset: it must win even when the keyboard commits an autocorrection first, which the
  // revision guard would otherwise treat as newer typing and keep, bringing the sent text back.
  // Events the editor sent before applying the reset are dropped for a moment.
  const resetSequenceRef = useRef(0);
  const previousValueRef = useRef(props.value);
  const renderedResetGenerationRef = useRef(readResetGeneration?.() ?? 0);
  const droppingSinceRef = useRef(0);
  const confirmedTokensRef = useRef(collectComposerInlineTokens(props.value));
  const bodyText = useScaledTextRole("body");
  const theme = useUniwindTheme();
  const fontFamily = useFontFamily("regular");

  const skillLabels = useMemo(
    () => new Map(skills.map((skill) => [skill.name, skill.displayName?.trim() || skill.name])),
    [skills],
  );
  const { modelsBySource, modelTokens } = useComposerModelTokens(props.value, models);
  const tokensJson = useMemo(() => {
    const tokens = collectComposerInlineTokens(props.value, {
      preserveTrailingFrom: confirmedTokensRef.current,
    });
    confirmedTokensRef.current = tokens;
    return JSON.stringify(
      composerContextEditorTokens(
        props.value,
        tokens,
        modelTokens,
        collectComposerLinkTokens(props.value),
      ).map((token) => {
        const model = token.type === "model" ? modelsBySource.get(token.source) : undefined;
        const record =
          token.type === "context"
            ? props.context?.records.find((record) => record.contextId === token.contextId)
            : undefined;
        return {
          // The editor draws models and site links as skill-style atoms with their own icon,
          // and a citation as a context chip that opens its sheet.
          type:
            token.type === "model" || token.type === "link"
              ? "skill"
              : token.type === "citation"
                ? "context"
                : token.type,
          source: token.source,
          start: token.start,
          end: token.end,
          ...contextChipPresentation(token.type === "context" ? token.kind : token.type, record),
          ...(token.type === "citation" ? { accent: citationChipAccent(theme) } : {}),
          label: model
            ? model.label
            : token.type === "skill" || token.type === "link"
              ? (skillLabels.get(token.value) ?? token.value)
              : token.type === "context"
                ? `${token.label}${props.context?.records.some((record) => record.contextId === token.contextId) ? "" : " · unavailable"}`
                : token.type === "citation"
                  ? token.value
                  : basename(token.value),
          detail: token.type === "context" ? composerChipSizeSuffix(record) : "",
          // Only a mention wears per-filetype artwork. An attachment chip keeps the tinted
          // monochrome glyph web draws for it: coloured artwork ignores the chip's accent and
          // makes the composer chip read differently from the same chip in a sent message.
          iconUri: model
            ? model.driver
              ? modelChipIconUri(model)
              : null
            : token.type === "link"
              ? linkChipIconUri(token.site)
              : token.type === "mention"
                ? fileIconUri(token.value)
                : record?.kind === "mention" && "path" in record
                  ? fileIconUri(record.path)
                  : null,
        };
      }),
    );
  }, [props.value, props.context, skillLabels, modelTokens, modelsBySource, theme]);
  // Every render resolves against the snapshot history, so a render whose
  // (value, selection) lags the acknowledged native state is stamped behind
  // the native revision and rejected by the editor instead of re-applying a
  // stale caret or stale text mid-typing.
  // Only a parent value going from text to empty counts. An empty parent lagging the first
  // keystroke never had text, and an empty value the editor itself reported is the user
  // deleting, not a reset.
  const snapshots = nativeEventSnapshotsRef.current;
  const resetGeneration = readResetGeneration?.() ?? 0;
  const ownerReset = resetGeneration !== renderedResetGenerationRef.current;
  renderedResetGenerationRef.current = resetGeneration;
  if (
    ownerReset ||
    (props.value === "" &&
      previousValueRef.current !== "" &&
      snapshots.length > 0 &&
      snapshots.every((snapshot) => snapshot.value !== ""))
  ) {
    resetSequenceRef.current += 1;
    // Each reset gets its own grace window for events from before it.
    droppingSinceRef.current = 0;
  }
  previousValueRef.current = props.value;
  const controlledEventCount = resolveComposerControlledEventCount(
    props.value,
    selection ?? null,
    mostRecentEventCount,
    nativeEventSnapshotsRef.current,
  );
  const acknowledgesLatestNativeEvent = isComposerNativeEcho(
    props.value,
    selection ?? null,
    mostRecentEventCount,
    nativeEventSnapshotsRef.current,
  );
  const isNativeEcho =
    controlledEventCount === mostRecentEventCount && acknowledgesLatestNativeEvent;
  const controlledDocumentJson = JSON.stringify({
    value: props.value,
    selection: isNativeEcho ? null : (selection ?? null),
    tokensJson,
    mostRecentEventCount: controlledEventCount,
    isNativeEcho,
    resetSequence: resetSequenceRef.current,
  });
  useEffect(() => {
    if (!acknowledgesLatestNativeEvent) return;
    nativeEventSnapshotsRef.current = pruneAcknowledgedComposerNativeEvents(
      nativeEventSnapshotsRef.current,
      mostRecentEventCount,
    );
  }, [acknowledgesLatestNativeEvent, mostRecentEventCount]);
  const assumedValue = props.value;
  useEffect(() => {
    // A native event that arrived after this render was committed moves the
    // acknowledged revision forward; the editor rejects this payload, so the
    // snapshot history must not assume it applied.
    if (isNativeEcho || controlledEventCount !== mostRecentEventCountRef.current) return;
    nativeEventSnapshotsRef.current = assumeComposerControlledState(
      nativeEventSnapshotsRef.current,
      controlledEventCount,
      assumedValue,
    );
  }, [assumedValue, controlledEventCount, isNativeEcho, controlledDocumentJson]);
  const acceptNativeEvent = useCallback(
    (
      eventCount: number,
      value: string,
      nextSelection: ComposerEditorSelection,
      resetSequence: number | undefined,
    ) => {
      if (readResetGeneration && readResetGeneration() !== renderedResetGenerationRef.current)
        return false;
      if ((resetSequence ?? 0) < resetSequenceRef.current) {
        if (readResetGeneration) return false;
        const now = Date.now();
        if (droppingSinceRef.current === 0) droppingSinceRef.current = now;
        if (now - droppingSinceRef.current < RESET_GRACE_MS) return false;
      } else {
        droppingSinceRef.current = 0;
      }
      const acknowledgedEventCount = acknowledgeComposerNativeEvent(
        mostRecentEventCountRef.current,
        eventCount,
      );
      if (acknowledgedEventCount === null) {
        return false;
      }
      mostRecentEventCountRef.current = acknowledgedEventCount;
      nativeEventSnapshotsRef.current.push({
        eventCount: acknowledgedEventCount,
        value,
        selection: nextSelection,
      });
      return acknowledgedEventCount;
    },
    [readResetGeneration],
  );
  useImperativeHandle(ref, () => ({
    focus: () => settleViewCommand(nativeRef.current?.focus()),
    blur: () => settleViewCommand(nativeRef.current?.blur()),
    setSelection: (nextSelection) =>
      settleViewCommand(nativeRef.current?.setSelection(nextSelection.start, nextSelection.end)),
    flushPendingInput: async () => {
      const state = await Promise.resolve()
        .then(() => nativeRef.current?.readState())
        .catch(() => undefined);
      // Do not acknowledge past an intercepted paste whose payload JS has yet to receive.
      if (!state || state.pasteEventCount > mostRecentEventCountRef.current) return;
      const count = acceptNativeEvent(
        state.eventCount,
        state.value,
        state.selection,
        state.resetSequence,
      );
      if (count === false) return;
      onChangeText(state.value);
      onSelectionChange?.(state.selection);
      setMostRecentEventCount(count);
      forceNativeEventRender((sequence) => sequence + 1);
    },
  }));
  const themeJson = JSON.stringify(createNativeComposerTheme(theme));
  const resolvedTextStyle = StyleSheet.flatten(textStyle) ?? {};
  const fontSize =
    (typeof resolvedTextStyle.fontSize === "number"
      ? resolvedTextStyle.fontSize
      : bodyText.fontSize) * fontScale;
  const lineHeight =
    (typeof resolvedTextStyle.lineHeight === "number"
      ? resolvedTextStyle.lineHeight
      : bodyText.lineHeight) * fontScale;
  const height = composerEditorHeight({
    contentHeight,
    lineHeight,
    contentInsetVertical,
    style: StyleSheet.flatten(style) ?? {},
  });
  return (
    <NativeView
      ref={nativeRef}
      controlledDocumentJson={controlledDocumentJson}
      clipboardFragment={props.clipboardFragment ?? ""}
      themeJson={themeJson}
      placeholder={props.placeholder ?? ""}
      fontFamily={
        typeof resolvedTextStyle.fontFamily === "string" ? resolvedTextStyle.fontFamily : fontFamily
      }
      fontSize={fontSize}
      lineHeight={lineHeight}
      contentInsetVertical={contentInsetVertical}
      editable={props.editable ?? true}
      readOnly={props.readOnly ?? false}
      enterBehavior={props.enterBehavior ?? DEFAULT_COMPOSER_ENTER_BEHAVIOR}
      submitTitle={props.submitTitle ?? "Send Message"}
      alternateSubmitTitle={props.alternateSubmitTitle ?? props.submitTitle ?? "Send Message"}
      scrollEnabled={props.scrollEnabled ?? true}
      autoFocus={props.autoFocus ?? false}
      autoCorrect={props.autoCorrect ?? true}
      spellCheck={props.spellCheck ?? true}
      textPasteThresholdBytes={onPasteText ? PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES : 0}
      maxInputChars={PROVIDER_SEND_TURN_MAX_INPUT_CHARS}
      style={[style as StyleProp<ViewStyle>, height === undefined ? undefined : { height }]}
      onComposerContentSizeChange={(event) => setContentHeight(event.nativeEvent.height)}
      onComposerChange={(event) => {
        const acknowledgedEventCount = acceptNativeEvent(
          event.nativeEvent.eventCount,
          event.nativeEvent.value,
          event.nativeEvent.selection,
          event.nativeEvent.resetSequence,
        );
        if (acknowledgedEventCount === false) return;
        // A reset confirmation only moves the revision forward. The parent's value stays: if it
        // restored a draft meanwhile (a failed send), the next render re-sends it at this
        // revision instead of the confirmation erasing it.
        if (event.nativeEvent.resetAck !== true) {
          onChangeText(event.nativeEvent.value);
          onSelectionChange?.(event.nativeEvent.selection);
        } else {
          // Everything recorded before the reset (including parent values the editor rejected
          // while it was pending) is superseded by the editor's confirmed empty state.
          nativeEventSnapshotsRef.current = nativeEventSnapshotsRef.current.slice(-1);
        }
        setMostRecentEventCount(acknowledgedEventCount);
        forceNativeEventRender((sequence) => sequence + 1);
      }}
      onComposerSelectionChange={(event) => {
        const acknowledgedEventCount = acceptNativeEvent(
          event.nativeEvent.eventCount,
          event.nativeEvent.value,
          event.nativeEvent.selection,
          event.nativeEvent.resetSequence,
        );
        if (acknowledgedEventCount === false) return;
        // A selection change that raced a text mutation can carry post-edit
        // text. It must reach the parent alongside the acknowledged revision,
        // or the next render stamps the stale draft at that revision and can
        // re-apply it over the newer native text.
        if (event.nativeEvent.value !== props.value) {
          onChangeText(event.nativeEvent.value);
        }
        onSelectionChange?.(event.nativeEvent.selection);
        setMostRecentEventCount(acknowledgedEventCount);
        forceNativeEventRender((sequence) => sequence + 1);
      }}
      onComposerPasteImages={(event) => onPasteImages?.(event.nativeEvent.uris)}
      onComposerContextPress={(event) => props.onContextPress?.(event.nativeEvent)}
      onComposerPasteContext={(event) => {
        const paste = event.nativeEvent;
        const acknowledgedEventCount = acceptNativeEvent(
          paste.eventCount,
          paste.value,
          paste.selection,
          paste.resetSequence,
        );
        if (acknowledgedEventCount === false) return;
        onChangeText(paste.value);
        onSelectionChange?.(paste.selection);
        props.onPasteContext?.(paste);
        setMostRecentEventCount(acknowledgedEventCount);
        forceNativeEventRender((sequence) => sequence + 1);
      }}
      onComposerPasteText={(event) => {
        const paste = event.nativeEvent;
        const acknowledgedEventCount = acceptNativeEvent(
          paste.eventCount,
          paste.value,
          paste.selection,
          paste.resetSequence,
        );
        if (acknowledgedEventCount === false) return;
        // Synchronize the draft before an async paste captures its insertion target.
        // React props can still precede the last native keystroke.
        onChangeText(paste.value);
        onSelectionChange?.(paste.selection);
        onPasteText?.(paste);
        setMostRecentEventCount(acknowledgedEventCount);
        forceNativeEventRender((sequence) => sequence + 1);
      }}
      onComposerFocus={onFocus}
      onComposerBlur={onBlur}
      onComposerSubmit={
        onSubmit === undefined
          ? undefined
          : (event) => onSubmit(event.nativeEvent.alternate === true)
      }
    />
  );
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
  ComposerTextPaste,
} from "./T3ComposerEditor.types";
