import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { G, Image as SvgImage, Path, Text as SvgText } from "react-native-svg";
import {
  changeMarkup,
  changeMarkupText,
  EMPTY_MARKUP_HISTORY,
  MARKUP_COLORS,
  MARKUP_SNAP_DURATION_MS,
  MARKUP_TEXT_WEIGHT,
  MARKUP_TOOLS,
  MARKUP_WIDTHS,
  markupName,
  markupPath,
  markupTextHalo,
  markupTextLayout,
  previewMarkup,
  redoMarkup,
  shapeBounds,
  undoMarkup,
  type MarkupItem,
  type MarkupShape,
  type MarkupText,
  type MarkupTool,
} from "@t3tools/client-runtime/image-markup";
import { AppText } from "./AppText";
import type { ResolvedFilePreviewSource } from "./FilePreviewModal.types";
import { ImageMarkupDraftKey } from "./ImageMarkupContext";
import { createMarkupGesture, createMarkupInteraction } from "./imageMarkupGesture";
import { attachMarkedImage, markupDraftAttachment } from "../state/imageMarkupAttachment";
import { useMediaActions } from "../state/mediaActions";
import { uuidv4 } from "../lib/uuid";

const TOOL_LABELS = {
  ellipse: "Circle",
  rectangle: "Rectangle",
  arrow: "Arrow",
  pen: "Pen",
  text: "Text",
};
const COLOR_LABELS = ["Red", "Yellow", "Green", "Blue", "White", "Black"];
const TEXT_EDIT_ACCENT = "#38bdf8";

function MarkupButton(props: {
  label: string;
  caption?: string;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected ?? false, disabled: props.disabled ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`min-h-11 min-w-11 items-center justify-center rounded-lg px-3 disabled:opacity-40 ${props.selected ? "bg-blue-600" : "active:bg-white/15"}`}
    >
      <AppText className="font-t3-medium text-sm text-white">
        {props.caption ?? props.label}
      </AppText>
    </Pressable>
  );
}

function MarkupTextInput(props: {
  label: MarkupText;
  width: number;
  height: number;
  onChange: (content: string) => void;
  onCommit: () => void;
}) {
  const { x, y, fontSize } = markupTextLayout(props.label, props.width, props.height);
  const font = {
    fontSize,
    fontWeight: `${MARKUP_TEXT_WEIGHT}`,
    lineHeight: fontSize * 1.2,
    includeFontPadding: false,
  } as const;
  return (
    <View
      style={{
        position: "absolute",
        left: x,
        top: y - fontSize,
        minWidth: fontSize / 2,
        paddingRight: 2,
      }}
    >
      <Text
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        allowFontScaling={false}
        numberOfLines={1}
        style={{ ...font, opacity: 0 }}
      >
        {props.label.content || "\u200b"}
      </Text>
      <View
        pointerEvents="none"
        style={{
          ...StyleSheet.absoluteFill,
          left: -2,
          right: -2,
          borderWidth: 1,
          borderStyle: "dashed",
          borderColor: TEXT_EDIT_ACCENT,
          borderRadius: 3,
        }}
      />
      {/* The SVG paints the draft. The native input handles the caret, selection, and IME. */}
      <TextInput
        accessibilityLabel="Markup text"
        autoFocus
        selectTextOnFocus={!!props.label.content}
        allowFontScaling={false}
        value={props.label.content}
        returnKeyType="done"
        underlineColorAndroid="transparent"
        selectionColor={Platform.OS === "android" ? `${TEXT_EDIT_ACCENT}66` : TEXT_EDIT_ACCENT}
        cursorColor={TEXT_EDIT_ACCENT}
        onChangeText={props.onChange}
        onBlur={props.onCommit}
        onSubmitEditing={props.onCommit}
        style={{
          ...StyleSheet.absoluteFill,
          ...font,
          padding: 0,
          color: "transparent",
          backgroundColor: "transparent",
        }}
      />
    </View>
  );
}

export function ImageMarkupEditor(props: {
  source: ResolvedFilePreviewSource;
  onCancel: () => void;
  onClose: () => void;
}) {
  const draftKey = useContext(ImageMarkupDraftKey);
  const [original] = useState(() =>
    draftKey ? markupDraftAttachment(draftKey, props.source) : undefined,
  );
  const insets = useSafeAreaInsets();
  const [image, setImage] = useState<{ uri: string; width: number; height: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [stage, setStage] = useState({ width: 1, height: 1 });
  const [tool, setTool] = useState<MarkupTool>("ellipse");
  const [color, setColor] = useState(MARKUP_COLORS[0]!);
  const [size, setSize] = useState(1);
  const [history, setHistory] = useState(EMPTY_MARKUP_HISTORY);
  const [drawing, setDrawing] = useState<MarkupItem | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<MarkupText | null>(null);
  const [snapped, setSnapped] = useState<MarkupShape | null>(null);
  const [interaction] = useState(createMarkupInteraction);
  const exportAfterEditing = useRef(false);
  const svg = useRef<Svg>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ uri: string; name: string } | null>(null);
  const files = useRef<string[]>([]);
  const mounted = useRef(true);
  const media = useMediaActions(
    result ? { uri: result.uri, name: result.name, mimeType: "image/png" } : undefined,
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
      const decoded = await ImageManipulator.manipulate(props.source.uri).renderAsync();
      try {
        const saved = await decoded.saveAsync({ format: SaveFormat.PNG });
        if (cancelled) {
          const { File } = await import("expo-file-system");
          new File(saved.uri).delete();
          return;
        }
        files.current.push(saved.uri);
        setImage({ uri: saved.uri, width: decoded.width, height: decoded.height });
      } finally {
        decoded.release();
      }
    })().catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load image.");
    });
    return () => {
      cancelled = true;
    };
  }, [props.source.uri]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const uris = files.current;
      void import("expo-file-system")
        .then(({ File }) => {
          for (const uri of uris) {
            const file = new File(uri);
            if (file.exists) file.delete();
          }
        })
        .catch(() => undefined);
    };
  }, []);
  const fit = image ? Math.min(stage.width / image.width, stage.height / image.height) : 1;
  const viewWidth = image ? image.width * fit : 1;
  const viewHeight = image ? image.height * fit : 1;
  const selectedText = history.present.find(
    (item): item is MarkupText => item.tool === "text" && item.id === selected,
  );
  useEffect(() => {
    if (!snapped) return;
    const timer = setTimeout(() => setSnapped(null), MARKUP_SNAP_DURATION_MS);
    return () => clearTimeout(timer);
  }, [snapped]);

  const startEditing = useCallback(
    (text: MarkupText) => {
      setSnapped(null);
      interaction.setTextDraft(text);
      setEditing(text);
    },
    [interaction],
  );
  const finishText = () => {
    const text = interaction.getTextDraft();
    if (!text) return;
    interaction.setTextDraft(null);
    Keyboard.dismiss();
    setHistory((value) => changeMarkupText(value, text));
    setSelected(text.content.trim() ? text.id : null);
    setEditing(null);
  };
  const undo = () => {
    finishText();
    setSnapped(null);
    setHistory(undoMarkup);
  };
  const redo = () => {
    finishText();
    setSnapped(null);
    setHistory(redoMarkup);
  };

  const gestureEnabled = loaded && !editing && !result && !busy;
  const gesture = useMemo(
    () =>
      createMarkupGesture({
        color,
        enabled: gestureEnabled,
        items: history.present,
        setDrawing,
        setHistory,
        setSelected,
        setSnapped,
        size,
        startEditing,
        state: interaction,
        tool,
        viewHeight,
        viewWidth,
      }),
    [
      gestureEnabled,
      tool,
      color,
      size,
      viewWidth,
      viewHeight,
      history.present,
      startEditing,
      interaction,
    ],
  );

  const attach = async (file: { uri: string; name: string }, replaceId?: string) => {
    if (!draftKey) return;
    await attachMarkedImage({ draftKey, ...file, ...(replaceId ? { replaceId } : {}) });
    if (mounted.current) props.onClose();
  };
  const run = async (task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Could not export image.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const done = () =>
    run(async () => {
      if (!image || !svg.current || !loaded || interaction.getActiveDrag()) return;
      const snapshot = svg.current;
      const base64 = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Image export timed out. Please try again.")),
          15_000,
        );
        // iOS's SVG renderer exports at device scale; normalize to the original pixels below.
        const scale = Platform.OS === "ios" ? PixelRatio.get() : 1;
        snapshot.toDataURL(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          {
            width: Math.max(1, Math.round(image.width / scale)),
            height: Math.max(1, Math.round(image.height / scale)),
          },
        );
      });
      if (!mounted.current) return;
      const [{ File, Paths }, { ImageManipulator, SaveFormat }] = await Promise.all([
        import("expo-file-system"),
        import("expo-image-manipulator"),
      ]);
      if (!mounted.current) return;
      const file = new File(Paths.cache, `markup-${uuidv4()}.png`);
      file.write(base64, { encoding: "base64" });
      files.current.push(file.uri);
      const rendered = await ImageManipulator.manipulate(file.uri)
        .resize({ width: image.width, height: image.height })
        .renderAsync();
      try {
        const saved = await rendered.saveAsync({ format: SaveFormat.PNG });
        files.current.push(saved.uri);
        if (!mounted.current) {
          new File(saved.uri).delete();
          return;
        }
        const output = { uri: saved.uri, name: markupName(props.source.name ?? "image") };
        if (original) await attach(output, original.id);
        else setResult(output);
      } finally {
        rendered.release();
      }
    });
  const cancel = () => {
    if (!busyRef.current && !media.busy) props.onCancel();
  };
  const finishExport = useEffectEvent(() => void done());
  useEffect(() => {
    if (!editing && exportAfterEditing.current) {
      exportAfterEditing.current = false;
      finishExport();
    }
  }, [editing]);
  const items = previewMarkup(history.present, editing ?? drawing);
  const snapBounds =
    snapped && history.present.at(-1) === snapped ? shapeBounds(snapped.points) : null;
  return (
    <Modal visible presentationStyle="fullScreen" animationType="fade" onRequestClose={cancel}>
      <GestureHandlerRootView
        style={{
          flex: 1,
          backgroundColor: "#000000",
          paddingTop: insets.top,
          paddingBottom: Math.max(insets.bottom, 12),
        }}
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View className="flex-row items-center justify-between px-2">
            <MarkupButton label="Cancel" disabled={busy || media.busy !== null} onPress={cancel} />
            <AppText className="font-t3-semibold text-white">Markup</AppText>
            {!result ? (
              <MarkupButton
                label={busy ? "Preparing…" : "Done"}
                disabled={busy || !loaded || !!drawing}
                onPress={() => {
                  if (interaction.getTextDraft()) {
                    exportAfterEditing.current = true;
                    finishText();
                  } else {
                    void done();
                  }
                }}
              />
            ) : (
              <MarkupButton
                label="Close"
                disabled={busy || media.busy !== null}
                onPress={props.onClose}
              />
            )}
          </View>
          {error && (
            <AppText
              accessibilityRole="alert"
              className="px-4 py-2 text-center text-sm text-red-400"
            >
              {error}
            </AppText>
          )}
          <View
            className="flex-1 items-center justify-center"
            onLayout={(event) => setStage(event.nativeEvent.layout)}
          >
            {editing && (
              <Pressable accessible={false} className="absolute inset-0" onPress={finishText} />
            )}
            {image ? (
              <View style={{ width: viewWidth, height: viewHeight }}>
                <GestureDetector gesture={gesture}>
                  <View collapsable={false} style={{ width: viewWidth, height: viewHeight }}>
                    {result ? (
                      <Image
                        source={{ uri: result.uri }}
                        style={{ width: viewWidth, height: viewHeight }}
                        resizeMode="contain"
                      />
                    ) : (
                      <Svg
                        ref={svg}
                        width={viewWidth}
                        height={viewHeight}
                        viewBox={`0 0 ${image.width} ${image.height}`}
                      >
                        <SvgImage
                          href={{ uri: image.uri }}
                          width={image.width}
                          height={image.height}
                          onLoad={() => setLoaded(true)}
                        />
                        {items.map((item) => {
                          if (item.tool === "text") {
                            const { x, y, fontSize } = markupTextLayout(
                              item,
                              image.width,
                              image.height,
                            );
                            return (
                              <G key={item.id} fontSize={fontSize} fontWeight={MARKUP_TEXT_WEIGHT}>
                                {markupTextHalo(item.color, fontSize).map((layer) => (
                                  <SvgText
                                    key={layer.width}
                                    x={x}
                                    y={y + layer.offset}
                                    fill="none"
                                    stroke={layer.color}
                                    strokeOpacity={layer.opacity}
                                    strokeWidth={layer.width}
                                    strokeLinejoin="round"
                                  >
                                    {item.content}
                                  </SvgText>
                                ))}
                                <SvgText x={x} y={y} fill={item.color}>
                                  {item.content}
                                </SvgText>
                              </G>
                            );
                          }
                          return (
                            <Path
                              key={item.id}
                              d={markupPath(item, image.width, image.height)}
                              fill="none"
                              stroke={item.color}
                              strokeWidth={item.width * Math.min(image.width, image.height)}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          );
                        })}
                      </Svg>
                    )}
                  </View>
                </GestureDetector>
                {!result && tool === "text" && (
                  <View
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    className="absolute inset-0 overflow-hidden"
                  >
                    {items.map((item) => {
                      if (item.tool !== "text" || editing?.id === item.id) return null;
                      const { x, y, fontSize } = markupTextLayout(item, viewWidth, viewHeight);
                      const highlighted = selected === item.id;
                      return (
                        <Text
                          key={item.id}
                          allowFontScaling={false}
                          numberOfLines={1}
                          onTextLayout={(event) => {
                            const width = event.nativeEvent.lines[0]?.width;
                            if (width !== undefined) interaction.setLabelWidth(item.id, width);
                          }}
                          style={{
                            position: "absolute",
                            left: x,
                            top: y - fontSize,
                            fontSize,
                            fontWeight: `${MARKUP_TEXT_WEIGHT}`,
                            color: "transparent",
                            borderBottomWidth: highlighted ? 1 : 0,
                            borderColor: "#38bdf8",
                          }}
                        >
                          {item.content}
                        </Text>
                      );
                    })}
                  </View>
                )}
                {!result && editing && (
                  <>
                    <Pressable
                      accessible={false}
                      className="absolute inset-0"
                      onPress={finishText}
                    />
                    <MarkupTextInput
                      key={editing.id}
                      label={editing}
                      width={viewWidth}
                      height={viewHeight}
                      onChange={(content) => {
                        const draft = interaction.getTextDraft();
                        if (!draft) return;
                        const next = { ...draft, content };
                        interaction.setTextDraft(next);
                        setEditing(next);
                      }}
                      onCommit={finishText}
                    />
                  </>
                )}
                {!result && snapBounds && (
                  <View
                    className="absolute"
                    style={{
                      left: Math.max(
                        0,
                        Math.min(
                          viewWidth - 128,
                          (snapBounds.x + snapBounds.width * 0.8) * viewWidth - 64,
                        ),
                      ),
                      top:
                        snapBounds.y * viewHeight >= 44
                          ? snapBounds.y * viewHeight - 44
                          : (snapBounds.y + snapBounds.height) * viewHeight,
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      onPress={undo}
                      hitSlop={6}
                      className="min-h-9 w-32 items-center justify-center rounded-lg bg-black/85"
                    >
                      <AppText className="font-t3-medium text-sm text-white">Keep freehand</AppText>
                    </Pressable>
                  </View>
                )}
              </View>
            ) : (
              !error && <AppText className="text-white/70">Loading image…</AppText>
            )}
          </View>
          {result ? (
            <View className="gap-2 px-3 pt-3">
              {draftKey && (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || media.busy !== null}
                  onPress={() => void run(() => attach(result))}
                  className="min-h-12 items-center justify-center rounded-xl bg-blue-600 disabled:opacity-40"
                >
                  <AppText className="font-t3-semibold text-white">
                    {busy ? "Attaching…" : "Add to chat"}
                  </AppText>
                </Pressable>
              )}
              <View className="flex-row flex-wrap justify-center">
                {media.actions
                  .filter((action) => action.id === "save-to-photos" || action.id === "save")
                  .map((action) => (
                    <MarkupButton
                      key={action.id}
                      label={action.title}
                      disabled={busy || action.disabled}
                      onPress={action.run}
                    />
                  ))}
                <MarkupButton
                  label="Keep editing"
                  disabled={busy || media.busy !== null}
                  onPress={() => {
                    setLoaded(false);
                    setResult(null);
                  }}
                />
              </View>
            </View>
          ) : (
            <View className="gap-1 px-2 pt-2">
              <View className="flex-row justify-center">
                {MARKUP_TOOLS.map((entry) => (
                  <MarkupButton
                    key={entry}
                    label={TOOL_LABELS[entry]}
                    caption={entry === "text" ? "T" : TOOL_LABELS[entry]}
                    selected={tool === entry}
                    disabled={busy}
                    onPress={() => {
                      finishText();
                      setSelected(null);
                      setTool(entry);
                    }}
                  />
                ))}
              </View>
              <View className="flex-row items-center justify-center gap-2">
                {MARKUP_COLORS.map((entry, index) => (
                  <Pressable
                    key={entry}
                    accessibilityRole="button"
                    accessibilityLabel={COLOR_LABELS[index]}
                    accessibilityState={{ selected: color === entry }}
                    disabled={busy}
                    onPress={() => {
                      finishText();
                      setColor(entry);
                    }}
                    className="min-h-11 min-w-11 items-center justify-center"
                  >
                    <View
                      style={{
                        width: 26,
                        height: 26,
                        backgroundColor: entry,
                        borderRadius: 13,
                        borderWidth: color === entry ? 3 : 1,
                        borderColor: color === entry ? "#60a5fa" : "#888888",
                      }}
                    />
                  </Pressable>
                ))}
              </View>
              <View className="flex-row flex-wrap items-center justify-center">
                {MARKUP_WIDTHS.map((entry, index) => (
                  <MarkupButton
                    key={entry}
                    label={
                      tool === "text"
                        ? ["Small text", "Medium text", "Large text"][index]!
                        : ["Thin stroke", "Medium stroke", "Thick stroke"][index]!
                    }
                    caption={["S", "M", "L"][index]!}
                    selected={size === index}
                    disabled={busy}
                    onPress={() => {
                      finishText();
                      setSize(index);
                    }}
                  />
                ))}
                <MarkupButton label="Undo" disabled={busy || !history.past.length} onPress={undo} />
                <MarkupButton
                  label="Redo"
                  disabled={busy || !history.future.length}
                  onPress={redo}
                />
                <MarkupButton
                  label={selectedText ? "Delete text" : "Clear"}
                  caption={selectedText ? "Delete" : "Clear"}
                  disabled={busy || !history.present.length}
                  onPress={() => {
                    finishText();
                    setSnapped(null);
                    setSelected(null);
                    setHistory((value) =>
                      selectedText
                        ? changeMarkupText(value, { ...selectedText, content: "" })
                        : changeMarkup(value, []),
                    );
                  }}
                />
              </View>
            </View>
          )}
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}
