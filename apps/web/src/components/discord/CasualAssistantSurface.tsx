import { useEffect, type ReactNode } from "react";
import type {
  CasualVoiceDisplay,
  CasualVoiceRole,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { CasualBurst, useCasualVisibility } from "./CasualBurst";
import { useCasualMessage } from "./useCasualVoice";

/** Display-only casual rewrite for one assistant message. Inactive, it renders the original. */
export function CasualAssistantSurface(props: {
  active: boolean;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  messageId: MessageId;
  original: string;
  streaming: boolean;
  runId: string | null;
  role: CasualVoiceRole;
  agent: string;
  revealOriginal: boolean;
  renderOriginal: (text: string) => ReactNode;
  renderBubble: (text: string) => ReactNode;
  footer?: (state: { display: CasualVoiceDisplay | null; show: () => void }) => ReactNode;
}) {
  const visibility = useCasualVisibility(props.active);
  const casual = useCasualMessage(
    props.environmentId,
    props.threadId,
    props.messageId,
    props.original,
    props.streaming,
    props.active,
    props.runId,
    props.role,
    visibility.visible,
  );
  useEffect(() => {
    if (props.revealOriginal) casual.show();
  }, [props.revealOriginal, casual.show]);
  const { copyToClipboard } = useCopyToClipboard<void>();
  const messageText = casual.text || (props.streaming ? "" : "(empty response)");
  return (
    <>
      <div
        ref={visibility.ref}
        data-thread-find-text="true"
        data-casual-voice={Boolean(casual.display) || undefined}
        onCopyCapture={
          casual.display
            ? (event) => {
                event.preventDefault();
                event.clipboardData.setData("text/plain", props.original);
              }
            : undefined
        }
      >
        {casual.display ? (
          <CasualBurst
            display={casual.display}
            live={casual.live}
            visible={visibility.visible}
            reducedMotion={visibility.reducedMotion}
            agent={props.agent}
            render={props.renderBubble}
          />
        ) : (
          props.renderOriginal(messageText)
        )}
      </div>
      {!props.runId && casual.display
        ? casual.display.blocks
            .filter((block) => block.kind === "status")
            .map((block) => (
              <p key={block.from} role="status" className="text-xs text-muted-foreground">
                {block.text}
              </p>
            ))
        : null}
      {casual.rewritten ? (
        <div data-casual-voice-actions className="flex gap-3 text-xs text-muted-foreground">
          <button type="button" onClick={casual.toggle}>
            {casual.showOriginal ? "show casual" : "show original"}
          </button>
          <button type="button" onClick={() => copyToClipboard(props.original)}>
            copy original
          </button>
        </div>
      ) : null}
      {props.footer?.({ display: casual.display, show: casual.show })}
    </>
  );
}
