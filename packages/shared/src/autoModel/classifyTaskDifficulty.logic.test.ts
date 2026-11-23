import { describe, expect, it } from "vite-plus/test";
import { fnv1a } from "../sessionBoxes/text.ts";
import {
  classifyTaskDifficulty,
  TASK_DIFFICULTY_CONFIDENT,
} from "./classifyTaskDifficulty.logic.ts";
import { taskDifficultyFixtures } from "./taskDifficulty.fixtures.ts";
import { taskDifficultyFeatures } from "./taskDifficultyFeatures.ts";
import { taskDifficultyLogit, taskFastProbability } from "./taskDifficultyModel.ts";
import { taskDifficultyWeights } from "./weights/taskDifficulty.ts";

describe("task difficulty model", () => {
  // The model only means something while this port produces exactly the features and
  // scores of the Python it was trained with.
  it.each(taskDifficultyFixtures.map((fixture, index) => [index, fixture] as const))(
    "matches the trained featurizer and model on fixture %i",
    (_, fixture) => {
      const features = taskDifficultyFeatures(fixture.text, fixture.attachmentCount);
      expect(features).toHaveLength(fixture.featureCount);
      expect(features.slice(0, 6).map(fnv1a)).toEqual(fixture.firstHashes);
      expect(features.at(-1) ?? null).toBe(fixture.lastFeature);
      expect(taskDifficultyLogit(fixture.text, fixture.attachmentCount)).toBeCloseTo(
        fixture.logit,
        5,
      );
    },
  );

  it("has one weight per bucket", () => {
    const bytes = atob(taskDifficultyWeights.weights).length;
    expect(bytes).toBe((taskDifficultyWeights.buckets * taskDifficultyWeights.weightBits) / 8);
    expect(taskDifficultyWeights.buckets & (taskDifficultyWeights.buckets - 1)).toBe(0);
  });
});

describe("classifyTaskDifficulty", () => {
  it.each(["fix the typo in the readme", "what does this function do?", "is node 24 installed"])(
    "suggests a fast model for a small single ask: %s",
    (text) => {
      const result = classifyTaskDifficulty({ text, attachmentCount: 0 });
      expect(result.tier).toBe("fast");
      expect(result.confidence).toBeGreaterThanOrEqual(TASK_DIFFICULTY_CONFIDENT);
      expect(result.confidence).toBeLessThanOrEqual(1);
    },
  );

  it.each([
    "Design and implement a job scheduler with retries, a web dashboard and tests. Start by researching how other tools do it.",
    "the app freezes when i open a long chat on my phone, figure out why and fix it",
    "refactor the auth module so sessions are stored server side, keep old clients working",
  ])("asks for the big model on real work: %s", (text) => {
    const result = classifyTaskDifficulty({ text, attachmentCount: 0 });
    expect(result.tier).toBe("big");
    expect(result.confidence).toBeGreaterThanOrEqual(TASK_DIFFICULTY_CONFIDENT);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("stays quiet between the two ends, and never calls an unsure task fast", () => {
    for (const fixture of taskDifficultyFixtures) {
      const fast = taskFastProbability(fixture.text, fixture.attachmentCount);
      const result = classifyTaskDifficulty(fixture);
      if (fast > taskDifficultyWeights.bigAt && fast < taskDifficultyWeights.fastAt) {
        expect(result).toEqual({ tier: "big", confidence: 0.5 });
      }
      if (result.tier === "fast") expect(fast).toBeGreaterThanOrEqual(taskDifficultyWeights.fastAt);
    }
  });
});

describe("classifyTaskDifficulty with a decision model's answer", () => {
  it("lets the decision model call a task hard where the local model has never seen the phrasing", () => {
    for (const [text, decisionQuick] of [
      ["build a black hole simulation", 0],
      ["can you build a black hole.", 0.14],
      ["Hi, what is the news? and can you build a black hole.", 0.22],
      ["make me a small tower defense game in the browser", 0],
    ] as const) {
      // Alone, the local model leans "simple" on each of these.
      expect(taskFastProbability(text, 0)).toBeGreaterThan(0.5);
      const result = classifyTaskDifficulty({ text, attachmentCount: 0, decisionQuick });
      expect(result.tier).toBe("big");
      expect(result.confidence).toBeGreaterThanOrEqual(TASK_DIFFICULTY_CONFIDENT);
    }
  });

  it("suggests a fast model when both agree the task is simple", () => {
    for (const text of ["fix the typo in the readme title", "what is the news"]) {
      const result = classifyTaskDifficulty({ text, attachmentCount: 0, decisionQuick: 0.97 });
      expect(result.tier).toBe("fast");
      expect(result.confidence).toBeGreaterThanOrEqual(TASK_DIFFICULTY_CONFIDENT);
    }
  });

  it("never suggests a fast model on the decision model's word alone", () => {
    const text = "users get logged out randomly, find out why and fix it";
    expect(taskFastProbability(text, 0)).toBeLessThan(0.3);
    expect(classifyTaskDifficulty({ text, attachmentCount: 0, decisionQuick: 0.95 }).tier).toBe(
      "big",
    );
  });

  it("stays quiet when the two disagree in the middle", () => {
    const result = classifyTaskDifficulty({
      text: "build a black hole simulation",
      attachmentCount: 0,
      decisionQuick: 0.5,
    });
    expect(result).toEqual({ tier: "big", confidence: 0.5 });
  });

  it("ignores an answer that is not a number", () => {
    const text = "fix the typo in the readme";
    expect(classifyTaskDifficulty({ text, attachmentCount: 0, decisionQuick: Number.NaN })).toEqual(
      classifyTaskDifficulty({ text, attachmentCount: 0 }),
    );
  });
});
