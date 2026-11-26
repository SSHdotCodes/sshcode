/** Identify app display features and media tools the agent can use in this harness. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const media =
    runtime.harness === "Antigravity"
      ? " On Gemini, use read_file for video and audio. For refused M4A, open a .mp4 copy. For refused AAC/FLAC, remux to MP4."
      : "";
  return `<runtime_info>The app shows images and videos you link in Markdown by absolute file path.${media}</runtime_info>`;
}
