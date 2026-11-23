/** Wait for the complete message so a WebView is not remounted on streamed tokens. */
export function mayRenderMath(markdown: string, isStreaming: boolean): boolean {
  return (
    !isStreaming && (markdown.includes("$") || markdown.includes("\\(") || markdown.includes("\\["))
  );
}
