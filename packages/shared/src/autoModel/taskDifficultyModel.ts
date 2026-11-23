import { fnv1a } from "../sessionBoxes/text.ts";
import { taskDifficultyFeatures } from "./taskDifficultyFeatures.ts";
import { taskDifficultyWeights } from "./weights/taskDifficulty.ts";

let decoded: Int8Array | Int16Array | null = null;

/** One weight per bucket, decoded once from the generated base64. */
function weightTable(): Int8Array | Int16Array {
  if (decoded === null) {
    const binary = atob(taskDifficultyWeights.weights);
    const wide = (taskDifficultyWeights.weightBits as number) === 16;
    const table = wide ? new Int16Array(binary.length / 2) : new Int8Array(binary.length);
    for (let index = 0; index < table.length; index++) {
      table[index] = wide
        ? ((binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8)) << 16) >> 16
        : (binary.charCodeAt(index) << 24) >> 24;
    }
    decoded = table;
  }
  return decoded;
}

/**
 * The model's logit that a fast model is enough for this first message. Each bucket
 * counts once however many features land in it, which is how the model was trained.
 */
export function taskDifficultyLogit(text: string, attachmentCount: number): number {
  const table = weightTable();
  const mask = taskDifficultyWeights.buckets - 1;
  const buckets = new Set<number>();
  for (const feature of taskDifficultyFeatures(text, attachmentCount)) {
    buckets.add(fnv1a(feature) & mask);
  }
  let logit: number = taskDifficultyWeights.bias;
  for (const bucket of buckets) logit += table[bucket]! * taskDifficultyWeights.scale;
  return logit;
}

/** Probability, 0 to 1, that a fast model is enough. */
export function taskFastProbability(text: string, attachmentCount: number): number {
  return 1 / (1 + Math.exp(-taskDifficultyLogit(text, attachmentCount)));
}
