import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Image, Modal, PixelRatio, Platform, Pressable, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Image as SvgImage, Path } from "react-native-svg";
import {
  changeMarkup,
  EMPTY_MARKUP_HISTORY,
  imagePoint,
  loopToEllipse,
  MARKUP_COLORS,
  MARKUP_TOOLS,
  MARKUP_WIDTHS,
  markupName,
  markupPath,
  redoMarkup,
  undoMarkup,
  type MarkupShape,
  type MarkupTool,
} from "@t3tools/client-runtime/image-markup";
import { AppText } from "./AppText";
import type { ResolvedFilePreviewSource } from "./FilePreviewModal.types";
import { ImageMarkupDraftKey } from "./ImageMarkupContext";
import { attachMarkedImage, markupDraftAttachment } from "../state/imageMarkupAttachment";
import { useMediaActions } from "../state/mediaActions";
import { uuidv4 } from "../lib/uuid";

const TOOL_LABELS = { ellipse: "Circle", rectangle: "Rectangle", arrow: "Arrow", pen: "Pen" };
const COLOR_LABELS = ["Red", "Yellow", "Green", "Blue", "White", "Black"];

function MarkupButton(props: {
  label: string;
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
      <AppText className="font-t3-medium text-sm text-white">{props.label}</AppText>
    </Pressable>
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
  const [width, setWidth] = useState(MARKUP_WIDTHS[1]!);
  const [history, setHistory] = useState(EMPTY_MARKUP_HISTORY);
  const [drawing, setDrawing] = useState<MarkupShape | null>(null);
  const active = useRef<MarkupShape | null>(null);
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

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .maxPointers(1)
        .enabled(loaded && !result && !busy)
        .runOnJS(true)
        .onStart((event) => {
          const shape = {
            tool,
            color,
            width,
            points: [imagePoint(event.x, event.y, viewWidth, viewHeight)],
          };
          active.current = shape;
          setDrawing(shape);
        })
        .onUpdate((event) => {
          const current = active.current;
          if (!current) return;
          const next = imagePoint(event.x, event.y, viewWidth, viewHeight);
          const shape = {
            ...current,
            points: current.tool === "pen" ? [...current.points, next] : [current.points[0]!, next],
          };
          active.current = shape;
          setDrawing(shape);
        })
        .onFinalize((_, success) => {
          const shape = active.current;
          if (success && shape)
            setHistory((value) => changeMarkup(value, [...value.present, loopToEllipse(shape)]));
          active.current = null;
          setDrawing(null);
        }),
    [busy, loaded, result, tool, color, width, viewWidth, viewHeight],
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
      if (!image || !svg.current || !loaded || active.current) return;
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
  const shapes = drawing ? [...history.present, drawing] : history.present;
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
        <View className="flex-row items-center justify-between px-2">
          <MarkupButton label="Cancel" disabled={busy || media.busy !== null} onPress={cancel} />
          <AppText className="font-t3-semibold text-white">Markup</AppText>
          {!result ? (
            <MarkupButton
              label={busy ? "Preparing…" : "Done"}
              disabled={busy || !loaded || !!drawing}
              onPress={() => void done()}
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
          <AppText accessibilityRole="alert" className="px-4 py-2 text-center text-sm text-red-400">
            {error}
          </AppText>
        )}
        <View
          className="flex-1 items-center justify-center"
          onLayout={(event) => setStage(event.nativeEvent.layout)}
        >
          {image ? (
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
                    {shapes.map((shape, index) => (
                      <Path
                        key={index}
                        d={markupPath(shape, image.width, image.height)}
                        fill="none"
                        stroke={shape.color}
                        strokeWidth={shape.width * Math.min(image.width, image.height)}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    ))}
                  </Svg>
                )}
              </View>
            </GestureDetector>
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
                  selected={tool === entry}
                  disabled={busy}
                  onPress={() => setTool(entry)}
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
                  onPress={() => setColor(entry)}
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
                  label={["Thin", "Medium", "Thick"][index]!}
                  selected={width === entry}
                  disabled={busy}
                  onPress={() => setWidth(entry)}
                />
              ))}
              <MarkupButton
                label="Undo"
                disabled={busy || !history.past.length}
                onPress={() => setHistory(undoMarkup)}
              />
              <MarkupButton
                label="Redo"
                disabled={busy || !history.future.length}
                onPress={() => setHistory(redoMarkup)}
              />
              <MarkupButton
                label="Clear"
                disabled={busy || !history.present.length}
                onPress={() => setHistory((value) => changeMarkup(value, []))}
              />
            </View>
          </View>
        )}
      </GestureHandlerRootView>
    </Modal>
  );
}
