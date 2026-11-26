/** Reads the base model's effort from its OpenCode settings or provider request body. */
export function configuredOpenCodeEffort(options: Readonly<Record<string, unknown>> | undefined) {
  const reasoning = options?.reasoning;
  const nested =
    reasoning && typeof reasoning === "object" && "effort" in reasoning
      ? reasoning.effort
      : undefined;
  const effort = nested ?? options?.reasoning_effort ?? options?.reasoningEffort;
  if (typeof effort === "string") return effort;

  const template = options?.chat_template_kwargs;
  if (
    template &&
    typeof template === "object" &&
    "enable_thinking" in template &&
    typeof template.enable_thinking === "boolean"
  )
    return template.enable_thinking ? "thinking" : "none";
  return undefined;
}
