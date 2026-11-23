/**
 * The one line T3 adds to every harness's own prompt: the app renders images
 * and videos the agent links by absolute path, which a terminal can't. The
 * harness and model are deliberately left out so the agent is prompted as it
 * would be in its own app.
 */
export function buildRuntimeInstructions(_runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  return "<runtime_info>The app shows images and videos you link in Markdown by absolute file path.</runtime_info>";
}
