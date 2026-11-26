import { useContext, useEffect, useRef, useState, type MouseEvent } from "react";
import {
  ArrowUpRightIcon,
  CircleIcon,
  PencilIcon,
  Redo2Icon,
  SquareIcon,
  TypeIcon,
  Undo2Icon,
} from "lucide-react";
import {
  appendMarkupStroke,
  changeMarkup,
  changeMarkupText,
  EMPTY_MARKUP_HISTORY,
  fitMarkupLoop,
  imagePoint,
  MARKUP_COLORS,
  MARKUP_SNAP_DURATION_MS,
  MARKUP_TEXT_SIZES,
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
  type MarkupPoint,
  type MarkupShape,
  type MarkupText,
  type MarkupTool,
} from "@t3tools/client-runtime/image-markup";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { MediaActionButtons, useMediaActions, type MediaActionSource } from "../media/MediaActions";
import { readMediaBlob } from "../media/mediaContent";
import type { ExpandedImageItem } from "./ExpandedImagePreview";
import { ImageMarkupContext } from "./ImageMarkupContext";
import { drawMarkup, MARKUP_FONT_FAMILY } from "./imageMarkupCanvas";

const TOOL_ICONS = {
  ellipse: CircleIcon,
  rectangle: SquareIcon,
  arrow: ArrowUpRightIcon,
  pen: PencilIcon,
  text: TypeIcon,
};
const TOOL_LABELS = {
  ellipse: "Circle",
  rectangle: "Rectangle",
  arrow: "Arrow",
  pen: "Pen",
  text: "Text",
};
const COLOR_LABELS = ["Red", "Yellow", "Green", "Blue", "White", "Black"];

type MarkupDrag =
  | { pointerId: number; shape: MarkupShape }
  | { pointerId: number; text: MarkupText; start: MarkupPoint; moved: boolean };

function focusTextInput(element: HTMLInputElement | null) {
  element?.focus({ preventScroll: true });
  if (element?.defaultValue) element.select();
}

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
  const [size, setSize] = useState(1);
  const [history, setHistory] = useState(EMPTY_MARKUP_HISTORY);
  const [drawing, setDrawing] = useState<MarkupItem | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<MarkupText | null>(null);
  const [snapped, setSnapped] = useState<MarkupShape | null>(null);
  const active = useRef<MarkupDrag | null>(null);
  const stage = useRef<SVGSVGElement>(null);
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
  useEffect(() => {
    if (!snapped) return;
    const timer = setTimeout(() => setSnapped(null), MARKUP_SNAP_DURATION_MS);
    return () => clearTimeout(timer);
  }, [snapped]);

  const point = (event: MouseEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return imagePoint(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      bounds.width,
      bounds.height,
    );
  };
  const textAt = (event: MouseEvent<SVGSVGElement>, at: MarkupPoint) => {
    if (!image || tool !== "text") return undefined;
    const x = at.x * image.naturalWidth;
    const y = at.y * image.naturalHeight;
    const labels = event.currentTarget.querySelectorAll<SVGTextElement>("text[data-markup-id]");
    for (let index = labels.length - 1; index >= 0; index--) {
      const label = labels[index]!;
      const bounds = label.getBBox();
      if (
        x >= bounds.x &&
        x <= bounds.x + bounds.width &&
        y >= bounds.y &&
        y <= bounds.y + bounds.height
      ) {
        return history.present.find(
          (item): item is MarkupText => item.tool === "text" && item.id === label.dataset.markupId,
        );
      }
    }
  };
  const undo = () => {
    setSnapped(null);
    setHistory(undoMarkup);
  };
  const redo = () => {
    setSnapped(null);
    setHistory(redoMarkup);
  };
  const cancelDrag = () => {
    active.current = null;
    setDrawing(null);
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
      drawMarkup(context, history.present, canvas.width, canvas.height);
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
  const items = previewMarkup(history.present, editing ?? drawing);
  const snapBounds =
    snapped && history.present.at(-1) === snapped ? shapeBounds(snapped.points) : null;
  return (
    <div
      className="flex max-h-full w-[var(--media-width)] max-w-full flex-col items-center gap-3 text-white"
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || busy || active.current || result) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          if (event.shiftKey) redo();
          else undo();
        } else if (event.key === "Backspace" || event.key === "Delete") {
          const text = history.present.find(
            (item): item is MarkupText => item.tool === "text" && item.id === selected,
          );
          if (!text) return;
          event.preventDefault();
          setHistory((value) => changeMarkupText(value, { ...text, content: "" }));
          setSelected(null);
        }
      }}
    >
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
              Back to preview
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
                  onClick={() => {
                    setSelected(null);
                    setTool(entry);
                  }}
                >
                  <Icon />
                </Button>
              );
            })}
            <div className="flex gap-1 px-2" role="group" aria-label="Markup color">
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
                variant={size === index ? "default" : "overlay"}
                size="sm"
                aria-label={
                  tool === "text"
                    ? `${["Small", "Medium", "Large"][index]} text`
                    : `${["Thin", "Medium", "Thick"][index]} stroke`
                }
                aria-pressed={size === index}
                disabled={busy}
                onClick={() => setSize(index)}
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
              onClick={undo}
            >
              <Undo2Icon />
            </Button>
            <Button
              variant="overlay"
              size="icon-sm"
              aria-label="Redo"
              title="Redo"
              disabled={busy || !history.future.length}
              onClick={redo}
            >
              <Redo2Icon />
            </Button>
            <Button
              variant="overlay"
              size="sm"
              disabled={busy || !history.present.length}
              onClick={() => {
                setSnapped(null);
                setSelected(null);
                setHistory((value) => changeMarkup(value, []));
              }}
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
          className="relative min-h-0 max-w-full select-none [container-type:inline-size]"
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
              ref={stage}
              tabIndex={0}
              className={`absolute inset-0 h-full w-full overflow-hidden touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60 ${tool === "text" ? "cursor-text" : "cursor-crosshair"}`}
              viewBox={`0 0 ${image.naturalWidth} ${image.naturalHeight}`}
              aria-label="Draw on image"
              onPointerDown={(event) => {
                if (busy || active.current || event.button !== 0 || !event.isPrimary) return;
                event.preventDefault();
                event.currentTarget.focus({ preventScroll: true });
                if (editing) return;
                setSnapped(null);
                const start = point(event);
                if (tool === "text") {
                  const text = textAt(event, start);
                  if (text) {
                    setSelected(text.id);
                    event.currentTarget.setPointerCapture(event.pointerId);
                    active.current = { pointerId: event.pointerId, text, start, moved: false };
                  } else {
                    setSelected(null);
                    setEditing({
                      tool,
                      id: randomUUID(),
                      point: start,
                      color,
                      size:
                        MARKUP_TEXT_SIZES[size]! /
                        event.currentTarget.getBoundingClientRect().width,
                      content: "",
                    });
                  }
                  return;
                }
                event.currentTarget.setPointerCapture(event.pointerId);
                const shape = {
                  tool,
                  id: randomUUID(),
                  color,
                  width: MARKUP_WIDTHS[size]!,
                  points: [start],
                };
                active.current = { pointerId: event.pointerId, shape };
                setDrawing(shape);
              }}
              onPointerMove={(event) => {
                const current = active.current;
                if (!current || current.pointerId !== event.pointerId) return;
                const next = point(event);
                if ("text" in current) {
                  const dx = next.x - current.start.x;
                  const dy = next.y - current.start.y;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  if (!current.moved && Math.hypot(dx * bounds.width, dy * bounds.height) < 3)
                    return;
                  active.current = { ...current, moved: true };
                  setDrawing({
                    ...current.text,
                    point: imagePoint(current.text.point.x + dx, current.text.point.y + dy, 1, 1),
                  });
                  return;
                }
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
                if ("text" in current) {
                  if (current.moved) {
                    const end = point(event);
                    const position = imagePoint(
                      current.text.point.x + end.x - current.start.x,
                      current.text.point.y + end.y - current.start.y,
                      1,
                      1,
                    );
                    setHistory((value) =>
                      changeMarkupText(value, { ...current.text, point: position }),
                    );
                  }
                } else {
                  const fit = fitMarkupLoop(current.shape);
                  setHistory((value) => appendMarkupStroke(value, current.shape, fit));
                  if (fit !== current.shape) setSnapped(fit);
                }
                cancelDrag();
              }}
              onDoubleClick={(event) => {
                if (busy || editing) return;
                const text = textAt(event, point(event));
                if (text) setEditing(text);
              }}
              onPointerCancel={cancelDrag}
              onLostPointerCapture={cancelDrag}
            >
              {items.map((item) => {
                if (item.tool === "text") {
                  const { x, y, fontSize } = markupTextLayout(
                    item,
                    image.naturalWidth,
                    image.naturalHeight,
                  );
                  return (
                    <g
                      key={item.id}
                      fontFamily={MARKUP_FONT_FAMILY}
                      fontSize={fontSize}
                      fontWeight={MARKUP_TEXT_WEIGHT}
                      xmlSpace="preserve"
                      style={{ direction: "ltr" }}
                    >
                      <g aria-hidden="true" pointerEvents="none">
                        {markupTextHalo(item.color, fontSize).map((layer) => (
                          <text
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
                          </text>
                        ))}
                      </g>
                      <text
                        data-markup-id={item.id}
                        x={x}
                        y={y}
                        fill={item.color}
                        className={
                          selected === item.id && !editing
                            ? "cursor-move outline-1 outline-dashed outline-primary"
                            : undefined
                        }
                      >
                        {item.content}
                      </text>
                    </g>
                  );
                }
                return (
                  <path
                    key={item.id}
                    d={markupPath(item, image.naturalWidth, image.naturalHeight)}
                    fill="none"
                    stroke={item.color}
                    strokeWidth={item.width * Math.min(image.naturalWidth, image.naturalHeight)}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                );
              })}
            </svg>
          )}
          {!result && editing && (
            <div
              key={editing.id}
              className="absolute w-max min-w-[0.5em] pe-0.5"
              dir="ltr"
              style={{
                left: `${editing.point.x * 100}%`,
                top: `${editing.point.y * 100}%`,
                fontFamily: MARKUP_FONT_FAMILY,
                fontWeight: MARKUP_TEXT_WEIGHT,
                fontSize: `${editing.size * 100}cqw`,
                lineHeight: 1.2,
              }}
            >
              <span aria-hidden="true" className="invisible block whitespace-pre">
                {editing.content || "\u200b"}
              </span>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -inset-x-0.5 inset-y-0 rounded-sm border border-dashed border-primary"
              />
              {/* Reuse the SVG glyphs and keep the browser's caret, selection, and IME. */}
              <input
                ref={focusTextInput}
                type="text"
                aria-label="Markup text"
                value={editing.content}
                className="absolute inset-0 size-full min-w-0 border-0 bg-transparent p-0 text-transparent caret-primary outline-none selection:bg-primary/25 selection:text-transparent"
                style={{ font: "inherit" }}
                onChange={(event) => setEditing({ ...editing, content: event.currentTarget.value })}
                onBlur={(event) => {
                  const content = event.currentTarget.value;
                  setHistory((value) => changeMarkupText(value, { ...editing, content }));
                  setSelected(content.trim() ? editing.id : null);
                  setEditing(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  stage.current?.focus({ preventScroll: true });
                }}
              />
            </div>
          )}
          {!result && snapBounds && (
            <div
              className={`absolute z-10 -translate-x-1/2 ${snapBounds.y >= 0.1 ? "-translate-y-full pb-1" : "pt-1"}`}
              style={{
                left: `clamp(4rem, ${(snapBounds.x + snapBounds.width * 0.8) * 100}%, 100% - 4rem)`,
                top: `${(snapBounds.y >= 0.1 ? snapBounds.y : snapBounds.y + snapBounds.height) * 100}%`,
              }}
            >
              <Button variant="overlay" size="sm" onClick={undo}>
                Keep freehand
              </Button>
            </div>
          )}
        </div>
      ) : (
        !error && <p role="status">Loading image…</p>
      )}
      {!result && (
        <p className="text-xs text-white/60">
          {tool === "text" ? "Click to place text. Double-click to edit." : "Drag to draw"}
        </p>
      )}
    </div>
  );
}
