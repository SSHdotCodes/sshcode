import { useContext, useEffect, useRef, useState, type PointerEvent } from "react";
import {
  ArrowUpRightIcon,
  CircleIcon,
  PencilIcon,
  Redo2Icon,
  SquareIcon,
  Undo2Icon,
} from "lucide-react";
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
import { Button } from "../ui/button";
import { MediaActionButtons, useMediaActions, type MediaActionSource } from "../media/MediaActions";
import { readMediaBlob } from "../media/mediaContent";
import type { ExpandedImageItem } from "./ExpandedImagePreview";
import { ImageMarkupContext } from "./ImageMarkupContext";

const TOOL_ICONS = {
  ellipse: CircleIcon,
  rectangle: SquareIcon,
  arrow: ArrowUpRightIcon,
  pen: PencilIcon,
};
const TOOL_LABELS = { ellipse: "Circle", rectangle: "Rectangle", arrow: "Arrow", pen: "Pen" };
const COLOR_LABELS = ["Red", "Yellow", "Green", "Blue", "White", "Black"];

export function ImageMarkupEditor(props: {
  item: ExpandedImageItem;
  source: MediaActionSource;
  onCancel: () => void;
  onClose: () => void;
}) {
  const composer = useContext(ImageMarkupContext);
  const [replacingDraft] = useState(() => composer?.isDraft(props.item) ?? false);
  const { actionUrl } = useMediaActions(props.source);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<MarkupTool>("ellipse");
  const [color, setColor] = useState(MARKUP_COLORS[0]!);
  const [width, setWidth] = useState(MARKUP_WIDTHS[1]!);
  const [history, setHistory] = useState(EMPTY_MARKUP_HISTORY);
  const [drawing, setDrawing] = useState<MarkupShape | null>(null);
  const active = useRef<{ pointerId: number; shape: MarkupShape } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ file: File; url: string } | null>(null);
  const resultUrl = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;
    void actionUrl()
      .then(readMediaBlob)
      .then(async (blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        const loaded = new Image();
        loaded.src = url;
        await loaded.decode();
        if (loaded.naturalWidth * loaded.naturalHeight > 64_000_000)
          throw new Error("This image is too large to mark up. Use a smaller image.");
        if (!cancelled) setImage(loaded);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load image.");
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [actionUrl]);

  const point = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return imagePoint(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      bounds.width,
      bounds.height,
    );
  };
  const attach = async (file: File, replace: boolean) => {
    if (!composer) return;
    setBusy(true);
    setError(null);
    try {
      await composer.attach(file, props.item, replace);
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not attach image.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const done = async () => {
    if (!image || busy || active.current) return;
    setBusy(true);
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image export is unavailable.");
      context.drawImage(image, 0, 0);
      context.lineCap = "round";
      context.lineJoin = "round";
      for (const shape of history.present) {
        context.strokeStyle = shape.color;
        context.lineWidth = shape.width * Math.min(canvas.width, canvas.height);
        context.stroke(new Path2D(markupPath(shape, canvas.width, canvas.height)));
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error("Could not export image."))),
          "image/png",
        ),
      );
      if (!mounted.current) return;
      const file = new File([blob], markupName(props.item.name), { type: "image/png" });
      if (replacingDraft) {
        await attach(file, true);
      } else {
        const url = URL.createObjectURL(file);
        resultUrl.current = url;
        setResult({ file, url });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export image.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const shapes = drawing ? [...history.present, drawing] : history.present;
  return (
    <div className="flex max-h-full w-[var(--media-width)] max-w-full flex-col items-center gap-3 text-white">
      <div
        className="flex flex-wrap items-center justify-center gap-1 rounded-xl bg-black/80 p-2"
        role="toolbar"
        aria-label="Image markup"
      >
        {result ? (
          <>
            {composer && (
              <Button disabled={busy} onClick={() => void attach(result.file, false)}>
                {busy ? "Attaching…" : "Add to chat"}
              </Button>
            )}
            <MediaActionButtons
              source={{ kind: "image", name: result.file.name, src: result.url }}
              renderButton={({ label, disabled, onClick }) => (
                <Button key={label} variant="overlay" disabled={disabled} onClick={onClick}>
                  {label}
                </Button>
              )}
            />
            <Button
              variant="overlay"
              onClick={() => {
                URL.revokeObjectURL(result.url);
                resultUrl.current = null;
                setResult(null);
              }}
            >
              Keep editing
            </Button>
            <Button variant="overlay" onClick={props.onCancel}>
              Close
            </Button>
          </>
        ) : (
          <>
            {MARKUP_TOOLS.map((entry) => {
              const Icon = TOOL_ICONS[entry];
              return (
                <Button
                  key={entry}
                  variant={tool === entry ? "default" : "overlay"}
                  size="icon-sm"
                  aria-label={TOOL_LABELS[entry]}
                  title={TOOL_LABELS[entry]}
                  aria-pressed={tool === entry}
                  disabled={busy}
                  onClick={() => setTool(entry)}
                >
                  <Icon />
                </Button>
              );
            })}
            <div className="flex gap-1 px-2" role="group" aria-label="Stroke color">
              {MARKUP_COLORS.map((entry, index) => (
                <button
                  key={entry}
                  type="button"
                  aria-label={COLOR_LABELS[index]}
                  aria-pressed={color === entry}
                  disabled={busy}
                  onClick={() => setColor(entry)}
                  className="flex size-8 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-white"
                  style={{ outline: color === entry ? "2px solid white" : undefined }}
                >
                  <span
                    className="size-5 rounded-full border border-white/50"
                    style={{ backgroundColor: entry }}
                  />
                </button>
              ))}
            </div>
            {MARKUP_WIDTHS.map((entry, index) => (
              <Button
                key={entry}
                variant={width === entry ? "default" : "overlay"}
                size="sm"
                aria-label={`${["Thin", "Medium", "Thick"][index]} stroke`}
                aria-pressed={width === entry}
                disabled={busy}
                onClick={() => setWidth(entry)}
              >
                {["S", "M", "L"][index]}
              </Button>
            ))}
            <Button
              variant="overlay"
              size="icon-sm"
              aria-label="Undo"
              title="Undo"
              disabled={busy || !history.past.length}
              onClick={() => setHistory(undoMarkup)}
            >
              <Undo2Icon />
            </Button>
            <Button
              variant="overlay"
              size="icon-sm"
              aria-label="Redo"
              title="Redo"
              disabled={busy || !history.future.length}
              onClick={() => setHistory(redoMarkup)}
            >
              <Redo2Icon />
            </Button>
            <Button
              variant="overlay"
              size="sm"
              disabled={busy || !history.present.length}
              onClick={() => setHistory((value) => changeMarkup(value, []))}
            >
              Clear
            </Button>
            <Button variant="overlay" size="sm" disabled={busy} onClick={props.onCancel}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || !image || !!drawing} onClick={() => void done()}>
              {busy ? "Preparing…" : "Done"}
            </Button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="max-w-lg text-center text-sm text-error">
          {error}
        </p>
      )}
      {image ? (
        <div
          className="relative min-h-0 max-w-full select-none"
          style={{
            width: `min(100%, ${image.naturalWidth}px, ${(62 * image.naturalWidth) / image.naturalHeight}vh)`,
          }}
        >
          <img
            src={result?.url ?? image.src}
            alt={props.item.name}
            draggable={false}
            className="block h-auto w-full rounded-lg"
          />
          {!result && (
            <svg
              className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
              viewBox={`0 0 ${image.naturalWidth} ${image.naturalHeight}`}
              aria-label="Draw on image"
              onPointerDown={(event) => {
                if (busy || active.current || event.button !== 0 || !event.isPrimary) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                const shape = { tool, color, width, points: [point(event)] };
                active.current = { pointerId: event.pointerId, shape };
                setDrawing(shape);
              }}
              onPointerMove={(event) => {
                const current = active.current;
                if (!current || current.pointerId !== event.pointerId) return;
                const next = point(event);
                const shape = {
                  ...current.shape,
                  points:
                    current.shape.tool === "pen"
                      ? [...current.shape.points, next]
                      : [current.shape.points[0]!, next],
                };
                active.current = { ...current, shape };
                setDrawing(shape);
              }}
              onPointerUp={(event) => {
                const current = active.current;
                if (!current || current.pointerId !== event.pointerId) return;
                const shape = loopToEllipse(current.shape);
                setHistory((value) => changeMarkup(value, [...value.present, shape]));
                active.current = null;
                setDrawing(null);
              }}
              onPointerCancel={() => {
                active.current = null;
                setDrawing(null);
              }}
              onLostPointerCapture={() => {
                active.current = null;
                setDrawing(null);
              }}
            >
              {shapes.map((shape, index) => (
                <path
                  key={index}
                  d={markupPath(shape, image.naturalWidth, image.naturalHeight)}
                  fill="none"
                  stroke={shape.color}
                  strokeWidth={shape.width * Math.min(image.naturalWidth, image.naturalHeight)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </svg>
          )}
        </div>
      ) : (
        !error && <p role="status">Loading image…</p>
      )}
      {!result && (
        <p className="text-xs text-white/60">Drag to draw · Circle is selected by default</p>
      )}
    </div>
  );
}
