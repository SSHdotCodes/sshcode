import { fnv1a } from "./text.ts";

/**
 * The tiny local models behind session boxes are hashed linear classifiers: each feature
 * string hashes into one of `buckets` rows of int8 weights, one weight per class. Small
 * enough to ship in the app (a few hundred KB together), fast enough to run on every
 * render, and trained offline on labels an open model produced from real chats.
 */
export interface HashedLinearModel {
  readonly version: number;
  /** Power of two. */
  readonly buckets: number;
  readonly classes: ReadonlyArray<string>;
  /** Multiplies the int8 weights back to floats. */
  readonly scale: number;
  /** Base64 of `buckets * classes.length` int8 weights, bucket-major. */
  readonly weights: string;
  readonly bias: ReadonlyArray<number>;
}

const decoded = new WeakMap<HashedLinearModel, Int8Array>();

function weightsOf(model: HashedLinearModel): Int8Array {
  let weights = decoded.get(model);
  if (!weights) {
    const binary = atob(model.weights);
    weights = new Int8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      weights[index] = (binary.charCodeAt(index) << 24) >> 24;
    }
    decoded.set(model, weights);
  }
  return weights;
}

/** Raw class scores (logits) for a bag of feature strings. */
export function hashedLinearScores(
  model: HashedLinearModel,
  features: ReadonlyArray<string>,
): number[] {
  const weights = weightsOf(model);
  const classCount = model.classes.length;
  const scores = model.bias.slice(0, classCount);
  const mask = model.buckets - 1;
  for (const feature of features) {
    const row = (fnv1a(feature) & mask) * classCount;
    for (let index = 0; index < classCount; index++) {
      scores[index]! += weights[row + index]! * model.scale;
    }
  }
  return scores;
}

export function softmax(scores: ReadonlyArray<number>): number[] {
  const max = Math.max(...scores);
  const exps = scores.map((score) => Math.exp(score - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map((value) => value / total);
}

/** The most likely class and its probability. */
export function hashedLinearPredict<C extends string>(
  model: HashedLinearModel,
  features: ReadonlyArray<string>,
): { readonly label: C; readonly probability: number } {
  const probabilities = softmax(hashedLinearScores(model, features));
  let best = 0;
  for (let index = 1; index < probabilities.length; index++) {
    if (probabilities[index]! > probabilities[best]!) best = index;
  }
  return { label: model.classes[best] as C, probability: probabilities[best]! };
}
