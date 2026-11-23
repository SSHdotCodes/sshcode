import type * as AcpSchema from "effect-acp/schema";

const DEFAULT_QA_MODELS = [
  { value: "qa-balanced", name: "QA Balanced" },
  { value: "qa-fast", name: "QA Fast" },
  { value: "qa-large", name: "QA Large" },
];

/**
 * A sandbox instance may list other models (`T3_QA_MODELS`, a JSON array of
 * `{ value, name }`), so several instances can serve one model, as real harnesses do.
 */
function configuredQaModels(raw: string | undefined) {
  if (!raw) return DEFAULT_QA_MODELS;
  try {
    const parsed: unknown = JSON.parse(raw);
    const models = Array.isArray(parsed)
      ? parsed.filter(
          (model): model is { value: string; name: string } =>
            typeof model?.value === "string" && typeof model?.name === "string",
        )
      : [];
    return models.length > 0 ? models : DEFAULT_QA_MODELS;
  } catch {
    return DEFAULT_QA_MODELS;
  }
}

export const QA_MODELS = configuredQaModels(process.env.T3_QA_MODELS);

/** Ordinary ACP descriptors, available only to the sandbox's local mock command. */
export function qaConfigOptions(state: {
  model: string;
  reasoning: string;
  context: string;
  fast: boolean;
}): Array<AcpSchema.SessionConfigOption> {
  return [
    {
      configId: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: state.model,
      options: QA_MODELS,
    },
    {
      configId: "reasoning",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: state.reasoning,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
    {
      configId: "fast",
      name: "Fast",
      category: "model_config",
      type: "boolean",
      currentValue: state.fast,
    },
    {
      configId: "context",
      name: "Context",
      category: "model_config",
      type: "select",
      currentValue: state.context,
      options: [
        { value: "272k", name: "272K" },
        { value: "1m", name: "1M" },
      ],
    },
  ];
}
