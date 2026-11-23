import { useMemo, type ReactNode } from "react";
import type { CasualVoiceDisplay, EnvironmentId } from "@t3tools/contracts";
import {
  casualVisibleText,
  segmentCasualMessage,
  type SteerReasoningReply,
} from "@t3tools/shared/casualVoice";
import { CornerUpRightIcon } from "lucide-react";
import { CasualBurst, useCasualVisibility } from "./CasualBurst";
import { useCasualMessage } from "./useCasualVoice";

/** One model decision for a closed steer window; no transcript or agent input changes. */
export function DiscordSteerReply({
  reply,
  rowId,
  live = false,
  environmentId,
  agent,
  header,
  render,
  plain = false,
}: {
  reply: SteerReasoningReply;
  rowId: string;
  live?: boolean;
  environmentId: EnvironmentId | null;
  agent: string;
  header: ReactNode;
  render: (text: string) => ReactNode;
  /** Normal layout: a compact line, no Discord avatar or member chrome. */
  plain?: boolean;
}) {
  const { ref: setVisibilityElement, visible, reducedMotion } = useCasualVisibility();
  const first = reply.items[0]!;
  const original = reply.items.map((item) => item.text).join("\n\n");
  const casual = useCasualMessage(
    environmentId,
    reply.steer.threadId,
    reply.steer.messageId,
    original,
    false,
    true,
    first.runId,
    "update",
    visible,
    first.id,
  );
  const sayOriginal = useMemo(() => {
    if (casual.decision?.kind !== "send") return null;
    const ids = new Set(casual.decision.segments);
    const chosen = segmentCasualMessage(original, "update").segments.filter((segment) =>
      ids.has(segment.id),
    );
    if (!chosen.length) return null;
    return chosen
      .map((segment, index) => (index ? segment.before : "") + segment.original)
      .join("");
  }, [casual.decision, original]);
  const textDisplay = (text: string): CasualVoiceDisplay => ({
    role: "update",
    blocks: [
      {
        from: 1,
        to: 1,
        kind: "say",
        bubbles: [text],
        text,
        original: text,
        before: "",
      },
    ],
    trailing: "",
  });
  const visibleDisplay = useMemo(
    () =>
      casual.display
        ? {
            ...casual.display,
            blocks: casual.display.blocks.filter((block) => block.kind !== "hide"),
          }
        : null,
    [casual.display],
  );
  // A parsed quiet decision, a failed steer, and a still-running rewrite all stay silent.
  const silent =
    casual.pending ||
    casual.decision?.kind === "quiet" ||
    (casual.rewritten &&
      !casual.showOriginal &&
      casual.display &&
      !casualVisibleText(casual.display).trim()) ||
    (!casual.rewritten && !sayOriginal);
  const steerText = reply.steer.text.replace(/\s+/g, " ").trim().slice(0, 180);
  const burst = (
    <CasualBurst
      display={
        casual.showOriginal
          ? textDisplay(original)
          : (visibleDisplay ?? textDisplay(sayOriginal ?? ""))
      }
      live={live && casual.rewritten && !casual.showOriginal}
      visible={visible}
      reducedMotion={reducedMotion}
      agent={agent}
      render={render}
    />
  );
  if (plain) {
    return (
      <div ref={setVisibilityElement}>
        {silent ? null : (
          <div
            data-timeline-row-id={rowId}
            data-timeline-row-kind="steer-reply"
            data-message-role="assistant"
            className="px-1 py-0.5"
          >
            <p className="mb-1 flex min-w-0 items-center gap-1.5 text-xs leading-relaxed text-muted-foreground">
              <CornerUpRightIcon aria-hidden="true" size={14} className="shrink-0" />
              <span className="truncate">
                {steerText ? `replying to your steer · ${steerText}` : "replying to your steer"}
              </span>
            </p>
            {burst}
            <div data-casual-voice-actions className="flex gap-3 text-xs text-muted-foreground">
              <button type="button" onClick={casual.toggle}>
                {casual.showOriginal ? "show reply" : "show original"}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
  return (
    <div ref={setVisibilityElement}>
      {silent ? null : (
        <div
          data-dc-timeline-row
          data-dc-message
          data-dc-start
          data-timeline-row-id={rowId}
          data-timeline-row-kind="steer-reply"
          data-message-role="assistant"
        >
          <div data-dc-reply-reference aria-label="Replying to your steer">
            <CornerUpRightIcon aria-hidden="true" size={14} />
            <span>{reply.steer.text.replace(/\s+/g, " ").trim().slice(0, 180)}</span>
          </div>
          {header}
          <div data-dc-steer-reply-item={first.id}>
            {burst}
            <div data-casual-voice-actions className="text-xs text-muted-foreground">
              <button type="button" onClick={casual.toggle}>
                {casual.showOriginal ? "show reply" : "show original"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
