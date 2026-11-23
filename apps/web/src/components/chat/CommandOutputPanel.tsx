import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { TERMINAL_PALETTES, terminalOutputSpans } from "@t3tools/shared/terminalOutput";
import { useMemo } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { ToolOutputText } from "./ToolOutputText";

function TerminalOutputText({ text }: { text: string }) {
  const { resolvedTheme } = useTheme();
  const spans = useMemo(
    () => terminalOutputSpans(text, TERMINAL_PALETTES[resolvedTheme]),
    [text, resolvedTheme],
  );
  return spans.map((span, index) =>
    span.style === null ? (
      span.text
    ) : (
      // Spans are rebuilt from scratch on every update and never reorder.
      // oxlint-disable-next-line react/no-array-index-key
      <span key={index} style={span.style}>
        {span.text}
      </span>
    ),
  );
}

const renderTerminalOutput = (text: string) => <TerminalOutputText text={text} />;

/** True when the environment streams command output; older servers only return final output. */
export function useCommandOutputStreaming(environmentId: EnvironmentId): boolean {
  return (
    useServerConfigs().get(environmentId)?.environment.capabilities.commandOutputStreaming === true
  );
}

/**
 * Output of one expanded command row: streams while the command runs, then
 * shows its final output. Mount it only when `useCommandOutputStreaming` holds.
 * It subscribes only while mounted, so collapsed rows and other threads receive nothing.
 */
export function CommandOutputPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
}) {
  const { data, error } = useEnvironmentQuery(
    orchestrationEnvironment.v2.commandOutput({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, itemId: props.itemId },
    }),
  );
  const text = data?.output.text ?? "";

  if (text.length === 0) {
    if (error) return <div className="text-destructive">Couldn&apos;t load output: {error}</div>;
    if (data === null) return <div className="text-muted-foreground italic">Loading output…</div>;
    return data.running ? null : <div className="text-muted-foreground italic">No output.</div>;
  }
  return (
    <div>
      {data?.output.truncated ? (
        <div className="text-muted-foreground italic">Earlier output not shown</div>
      ) : null}
      <ToolOutputText
        text={text}
        running={data?.running ?? false}
        renderText={renderTerminalOutput}
      />
    </div>
  );
}
