/**
 * Public benchmark figures for the models people run here, gathered on `asOf`.
 *
 * Generated: edit `scripts/model-benchmarks/benchmarks.json` and run
 * `node scripts/model-benchmarks/generate.ts`. Every figure there carries its
 * source and date; a figure nobody published is simply absent.
 *
 * @module modelBenchmarks
 */
import type { PickBenchmarkSource } from "./modelPicks.ts";

export interface ModelBenchmarkMetric {
  readonly label: string;
  readonly version?: string;
  readonly publisher?: string;
  readonly url?: string;
}

/** Read it through `benchmarksAtEffort` to get the figures for the effort someone runs. */
export interface ModelBenchmarkTable {
  /** Day the table was gathered, `YYYY-MM-DD`. */
  readonly asOf: string;
  /** Set when live figures were laid over it: the publisher to credit beside them. */
  readonly liveSource?: string;
  readonly metrics: Readonly<Record<string, ModelBenchmarkMetric>>;
  readonly models: ReadonlyArray<PickBenchmarkSource>;
}

export const MODEL_BENCHMARKS: ModelBenchmarkTable = {
  asOf: "2026-11-10",
  metrics: {
    aaIntelligenceIndex: {
      label: "Intelligence Index",
      version: "5.0.1",
      publisher: "Artificial Analysis",
      url: "https://artificialanalysis.ai/methodology/intelligence-benchmarking",
    },
    aaCodingAgentIndex: {
      label: "Coding Agent Index",
      version: "2.0",
      publisher: "Artificial Analysis",
      url: "https://artificialanalysis.ai/methodology/coding-agents-benchmarking/",
    },
    terminalBench: {
      label: "Terminal-Bench",
      version: "4.1",
      publisher: "Terminal-Bench / Stanford / Harbor / Laude Institute",
      url: "https://www.tbench.ai/",
    },
    sweBenchPro: {
      label: "SWE-Bench Pro V2 Full",
      publisher: "Scale Labs / Reflection",
      url: "https://labs.scale.com/leaderboard/swe_bench_pro_public_v2?tab=full",
    },
  },
  models: [
    {
      id: "claude-fable-5-2",
      label: "Claude Fable 5.2",
      aaSlug: "claude-fable-5-2",
      scores: {
        aaIntelligenceIndex: 65,
      },
      outputTokensPerSecond: 102.7,
      outputTokensPerTask: 273776,
      efforts: {
        xhigh: {
          aaSlug: "claude-fable-5-2-xhigh",
          scores: {
            aaIntelligenceIndex: 62,
          },
          outputTokensPerSecond: 103.2,
          outputTokensPerTask: 161944,
        },
        max: {
          aaSlug: "claude-fable-5-2",
          scores: {
            aaIntelligenceIndex: 65,
          },
          outputTokensPerSecond: 102.7,
          outputTokensPerTask: 273776,
        },
        high: {
          aaSlug: "claude-fable-5-2-high",
          scores: {
            aaIntelligenceIndex: 62,
          },
          outputTokensPerSecond: 93.3,
          outputTokensPerTask: 97841,
        },
        medium: {
          aaSlug: "claude-fable-5-2-medium",
          scores: {
            aaIntelligenceIndex: 56,
          },
          outputTokensPerSecond: 90.7,
          outputTokensPerTask: 43131,
        },
        low: {
          aaSlug: "claude-fable-5-2-low",
          scores: {
            aaIntelligenceIndex: 54,
          },
          outputTokensPerSecond: 92.8,
          outputTokensPerTask: 35860,
        },
      },
      price: {
        inputPerMTok: 8,
        outputPerMTok: 40,
        cachedInputPerMTok: 0.2,
        cacheWritePerMTok: 10,
      },
    },
    {
      id: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      aaSlug: "claude-opus-5-5",
      scores: {
        aaIntelligenceIndex: 59,
        aaCodingAgentIndex: 62,
        terminalBench: 65.76,
      },
      outputTokensPerSecond: 115.9,
      outputTokensPerTask: 173313,
      efforts: {
        xhigh: {
          aaSlug: "claude-opus-5-5-xhigh",
          scores: {
            aaIntelligenceIndex: 57,
          },
          outputTokensPerSecond: 107.9,
          outputTokensPerTask: 103395,
        },
        max: {
          aaSlug: "claude-opus-5-5",
          scores: {
            aaIntelligenceIndex: 59,
            aaCodingAgentIndex: 62,
            terminalBench: 65.76,
          },
          outputTokensPerSecond: 115.9,
          outputTokensPerTask: 173313,
        },
        high: {
          aaSlug: "claude-opus-5-5-high",
          scores: {
            aaIntelligenceIndex: 52,
          },
          outputTokensPerSecond: 104.5,
          outputTokensPerTask: 60071,
        },
        medium: {
          aaSlug: "claude-opus-5-5-medium",
          scores: {
            aaIntelligenceIndex: 48,
          },
          outputTokensPerSecond: 103.2,
          outputTokensPerTask: 43817,
        },
        low: {
          aaSlug: "claude-opus-5-5-low",
          scores: {
            aaIntelligenceIndex: 35,
          },
          outputTokensPerSecond: 106.7,
          outputTokensPerTask: 19060,
        },
      },
      price: {
        inputPerMTok: 4,
        outputPerMTok: 20,
        cachedInputPerMTok: 0.2,
        cacheWritePerMTok: 5,
      },
    },
    {
      id: "claude-sonnet-5-5",
      label: "Claude Sonnet 5.5",
      aaSlug: "claude-sonnet-5-5",
      scores: {
        aaIntelligenceIndex: 55,
        aaCodingAgentIndex: 59,
        terminalBench: 63.94,
        sweBenchPro: 95.79,
      },
      outputTokensPerSecond: 151.5,
      outputTokensPerTask: 285387,
      efforts: {
        xhigh: {
          aaSlug: "claude-sonnet-5-5-xhigh",
          scores: {
            aaIntelligenceIndex: 50,
            sweBenchPro: 95.79,
          },
          outputTokensPerSecond: 137.4,
          outputTokensPerTask: 122205,
        },
        max: {
          aaSlug: "claude-sonnet-5-5",
          scores: {
            aaIntelligenceIndex: 55,
            aaCodingAgentIndex: 59,
            terminalBench: 63.94,
          },
          outputTokensPerSecond: 151.5,
          outputTokensPerTask: 285387,
        },
        high: {
          aaSlug: "claude-sonnet-5-5-high",
          scores: {
            aaIntelligenceIndex: 42,
          },
          outputTokensPerSecond: 140.2,
          outputTokensPerTask: 58421,
        },
        medium: {
          aaSlug: "claude-sonnet-5-5-medium",
          scores: {
            aaIntelligenceIndex: 31,
          },
          outputTokensPerSecond: 141.7,
          outputTokensPerTask: 30746,
        },
        low: {
          aaSlug: "claude-sonnet-5-5-low",
          scores: {
            aaIntelligenceIndex: 26,
          },
          outputTokensPerSecond: 135.8,
          outputTokensPerTask: 20856,
        },
      },
      price: {
        inputPerMTok: 2,
        outputPerMTok: 10,
        cachedInputPerMTok: 0.1,
        cacheWritePerMTok: 2.5,
      },
    },
    {
      id: "claude-haiku-5-5",
      label: "Claude Haiku 5.5",
      aaSlug: "claude-haiku-5-5",
      scores: {
        aaIntelligenceIndex: 36,
        aaCodingAgentIndex: 37,
        sweBenchPro: 87.23,
      },
      outputTokensPerSecond: 253.8,
      outputTokensPerTask: 225966,
      efforts: {
        xhigh: {
          aaSlug: "claude-haiku-5-5-xhigh",
          scores: {
            aaIntelligenceIndex: 35,
          },
          outputTokensPerSecond: 235.7,
          outputTokensPerTask: 136177,
        },
        max: {
          aaSlug: "claude-haiku-5-5",
          scores: {
            aaIntelligenceIndex: 36,
            aaCodingAgentIndex: 37,
          },
          outputTokensPerSecond: 253.8,
          outputTokensPerTask: 225966,
        },
        high: {
          aaSlug: "claude-haiku-5-5-high",
          scores: {
            aaIntelligenceIndex: 30,
            sweBenchPro: 87.23,
          },
          outputTokensPerSecond: 228.2,
          outputTokensPerTask: 88064,
        },
        medium: {
          aaSlug: "claude-haiku-5-5-medium",
          scores: {
            aaIntelligenceIndex: 25,
          },
          outputTokensPerSecond: 222.4,
          outputTokensPerTask: 53335,
        },
        low: {
          aaSlug: "claude-haiku-5-5-low",
          scores: {
            aaIntelligenceIndex: 19,
          },
          outputTokensPerSecond: 217.3,
          outputTokensPerTask: 28161,
        },
      },
      price: {
        inputPerMTok: 0.1,
        outputPerMTok: 0.5,
        cachedInputPerMTok: 0.01,
        cacheWritePerMTok: 0.125,
      },
    },
    {
      id: "gpt-6.2-sol",
      label: "GPT-6.2 Sol",
      aaSlug: "gpt-6-2-sol",
      scores: {},
      outputTokensPerTask: 40360,
      efforts: {
        xhigh: {
          aaSlug: "gpt-6-2-sol-xhigh",
          outputTokensPerTask: 24323,
        },
        max: {
          aaSlug: "gpt-6-2-sol",
          outputTokensPerTask: 40360,
        },
        high: {
          aaSlug: "gpt-6-2-sol-high",
          outputTokensPerTask: 20160,
        },
        medium: {
          aaSlug: "gpt-6-2-sol-medium",
          outputTokensPerTask: 13651,
        },
        low: {
          aaSlug: "gpt-6-2-sol-low",
          outputTokensPerTask: 5980,
        },
      },
    },
    {
      id: "gpt-6.2-astra",
      label: "GPT-6.2 Astra",
      aaSlug: "gpt-6-2-astra",
      scores: {},
      outputTokensPerTask: 41029,
      efforts: {
        xhigh: {
          aaSlug: "gpt-6-2-astra-xhigh",
          outputTokensPerTask: 22238,
        },
        max: {
          aaSlug: "gpt-6-2-astra",
          outputTokensPerTask: 41029,
        },
        high: {
          aaSlug: "gpt-6-2-astra-high",
          outputTokensPerTask: 17828,
        },
        medium: {
          aaSlug: "gpt-6-2-astra-medium",
          outputTokensPerTask: 13165,
        },
        low: {
          aaSlug: "gpt-6-2-astra-low",
          outputTokensPerTask: 5216,
        },
      },
    },
    {
      id: "gpt-6.1-sol",
      label: "GPT-6.1 Sol",
      aaSlug: "gpt-6-1-sol",
      scores: {
        aaIntelligenceIndex: 55,
        aaCodingAgentIndex: 54,
        terminalBench: 60.91,
        sweBenchPro: 96.11,
      },
      outputTokensPerSecond: 55.6,
      fastOutputTokensPerSecond: 76.5,
      outputTokensPerTask: 67824,
      efforts: {
        xhigh: {
          aaSlug: "gpt-6-1-sol-xhigh",
          scores: {
            aaIntelligenceIndex: 52,
            sweBenchPro: 96.11,
          },
          outputTokensPerSecond: 53.5,
          outputTokensPerTask: 30241,
        },
        max: {
          aaSlug: "gpt-6-1-sol",
          scores: {
            aaIntelligenceIndex: 55,
            aaCodingAgentIndex: 54,
            terminalBench: 60.91,
          },
          outputTokensPerSecond: 55.6,
          outputTokensPerTask: 67824,
        },
        high: {
          aaSlug: "gpt-6-1-sol-high",
          scores: {
            aaIntelligenceIndex: 50,
          },
          outputTokensPerSecond: 56.8,
          outputTokensPerTask: 22606,
        },
        medium: {
          aaSlug: "gpt-6-1-sol-medium",
          scores: {
            aaIntelligenceIndex: 46,
          },
          outputTokensPerSecond: 58.2,
          outputTokensPerTask: 13518,
        },
        low: {
          aaSlug: "gpt-6-1-sol-low",
          scores: {
            aaIntelligenceIndex: 35,
          },
          outputTokensPerSecond: 54.4,
          outputTokensPerTask: 5838,
        },
      },
      price: {
        inputPerMTok: 2,
        outputPerMTok: 10,
        cachedInputPerMTok: 0.1,
        cacheWritePerMTok: 2.5,
      },
    },
    {
      id: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      aaSlug: "gpt-6-1-terra",
      scores: {
        aaIntelligenceIndex: 51,
        aaCodingAgentIndex: 48,
      },
      outputTokensPerSecond: 72.5,
      outputTokensPerTask: 59883,
      efforts: {
        xhigh: {
          aaSlug: "gpt-6-1-terra-xhigh",
          scores: {
            aaIntelligenceIndex: 45,
            aaCodingAgentIndex: 48,
          },
          outputTokensPerSecond: 71.1,
          outputTokensPerTask: 26200,
        },
        max: {
          aaSlug: "gpt-6-1-terra",
          scores: {
            aaIntelligenceIndex: 51,
            aaCodingAgentIndex: 48,
          },
          outputTokensPerSecond: 72.5,
          outputTokensPerTask: 59883,
        },
        high: {
          aaSlug: "gpt-6-1-terra-high",
          scores: {
            aaIntelligenceIndex: 42,
            aaCodingAgentIndex: 46,
          },
          outputTokensPerSecond: 69.1,
          outputTokensPerTask: 16746,
        },
        medium: {
          aaSlug: "gpt-6-1-terra-medium",
          scores: {
            aaIntelligenceIndex: 38,
            aaCodingAgentIndex: 42,
          },
          outputTokensPerSecond: 68.8,
          outputTokensPerTask: 10875,
        },
        low: {
          aaSlug: "gpt-6-1-terra-low",
          scores: {
            aaIntelligenceIndex: 29,
            aaCodingAgentIndex: 35,
          },
          outputTokensPerSecond: 67.2,
          outputTokensPerTask: 4422,
        },
        none: {
          aaSlug: "gpt-6-1-terra-non-reasoning",
          scores: {
            aaIntelligenceIndex: 31,
            aaCodingAgentIndex: 39,
          },
          outputTokensPerSecond: 69,
          outputTokensPerTask: 9488,
        },
      },
      price: {
        inputPerMTok: 1,
        outputPerMTok: 5,
        cachedInputPerMTok: 0.05,
        cacheWritePerMTok: 1.25,
      },
    },
    {
      id: "gpt-6-astra",
      label: "GPT-6 Astra",
      aaSlug: "gpt-6-astra",
      scores: {
        aaIntelligenceIndex: 57,
        aaCodingAgentIndex: 55,
        terminalBench: 60.3,
        sweBenchPro: 96.9,
      },
      outputTokensPerSecond: 37.2,
      outputTokensPerTask: 51973,
      efforts: {
        xhigh: {
          aaSlug: "gpt-6-astra-xhigh",
          scores: {
            aaIntelligenceIndex: 55,
            terminalBench: 59.7,
          },
          outputTokensPerSecond: 39.2,
          outputTokensPerTask: 26724,
        },
        max: {
          aaSlug: "gpt-6-astra",
          scores: {
            aaIntelligenceIndex: 57,
            aaCodingAgentIndex: 55,
            terminalBench: 60.3,
          },
          outputTokensPerSecond: 37.2,
          outputTokensPerTask: 51973,
        },
        high: {
          aaSlug: "gpt-6-astra-high",
          scores: {
            aaIntelligenceIndex: 55,
            terminalBench: 60,
            sweBenchPro: 96.9,
          },
          outputTokensPerSecond: 39.1,
          outputTokensPerTask: 23133,
        },
        medium: {
          aaSlug: "gpt-6-astra-medium",
          scores: {
            aaIntelligenceIndex: 52,
            terminalBench: 55.15,
          },
          outputTokensPerSecond: 42.7,
          outputTokensPerTask: 18052,
        },
        low: {
          aaSlug: "gpt-6-astra-low",
          scores: {
            aaIntelligenceIndex: 43,
            terminalBench: 50.91,
          },
          outputTokensPerSecond: 39.4,
          outputTokensPerTask: 9126,
        },
      },
      price: {
        inputPerMTok: 10,
        outputPerMTok: 50,
        cachedInputPerMTok: 1,
        cacheWritePerMTok: 12.5,
      },
    },
    {
      id: "gpt-6-luna",
      label: "GPT-6 Luna",
      aaSlug: "gpt-6-luna",
      scores: {
        aaIntelligenceIndex: 28,
        aaCodingAgentIndex: 31,
        terminalBench: 15.15,
      },
      outputTokensPerSecond: 103.8,
      outputTokensPerTask: 75296,
      efforts: {
        xhigh: {
          aaSlug: "gpt-6-luna-xhigh",
          scores: {
            aaIntelligenceIndex: 23,
          },
          outputTokensPerSecond: 102.6,
          outputTokensPerTask: 43893,
        },
        max: {
          aaSlug: "gpt-6-luna",
          scores: {
            aaIntelligenceIndex: 28,
            aaCodingAgentIndex: 31,
            terminalBench: 15.15,
          },
          outputTokensPerSecond: 103.8,
          outputTokensPerTask: 75296,
        },
        high: {
          aaSlug: "gpt-6-luna-high",
          scores: {
            aaIntelligenceIndex: 21,
          },
          outputTokensPerSecond: 96.3,
          outputTokensPerTask: 32839,
        },
        medium: {
          aaSlug: "gpt-6-luna-medium",
          scores: {
            aaIntelligenceIndex: 18,
          },
          outputTokensPerSecond: 98.1,
          outputTokensPerTask: 19823,
        },
        low: {
          aaSlug: "gpt-6-luna-low",
          scores: {
            aaIntelligenceIndex: 10,
          },
          outputTokensPerSecond: 87,
          outputTokensPerTask: 3296,
        },
        none: {
          aaSlug: "gpt-6-luna-non-reasoning",
          scores: {
            aaIntelligenceIndex: 9,
          },
          outputTokensPerSecond: 75.4,
          outputTokensPerTask: 10059,
        },
      },
      price: {
        inputPerMTok: 0.1,
        outputPerMTok: 0.5,
        cachedInputPerMTok: 0.01,
        cacheWritePerMTok: 0.125,
      },
    },
    {
      id: "grok-4.7",
      label: "Grok 4.7",
      aaSlug: "grok-4-7",
      scores: {
        aaIntelligenceIndex: 35,
        aaCodingAgentIndex: 47,
        terminalBench: 38.79,
      },
      outputTokensPerSecond: 66.4,
      outputTokensPerTask: 104531,
      efforts: {
        xhigh: {
          aaSlug: "grok-4-7",
          scores: {
            aaIntelligenceIndex: 35,
            aaCodingAgentIndex: 47,
            terminalBench: 38.79,
          },
          outputTokensPerSecond: 66.4,
          outputTokensPerTask: 104531,
        },
        high: {
          aaSlug: "grok-4-7-high",
          scores: {
            aaIntelligenceIndex: 35,
          },
          outputTokensPerSecond: 68.9,
          outputTokensPerTask: 89127,
        },
        low: {
          aaSlug: "grok-4-7-low",
          scores: {
            aaIntelligenceIndex: 31,
          },
          outputTokensPerSecond: 66.3,
          outputTokensPerTask: 42670,
        },
      },
      price: {
        inputPerMTok: 2,
        outputPerMTok: 6,
        cachedInputPerMTok: 0.5,
      },
    },
    {
      id: "grok-4.7-build-fast",
      label: "Grok 4.7 Fast",
      scores: {},
    },
    {
      id: "k3",
      label: "Kimi K3",
      aaSlug: "kimi-k3",
      scores: {
        aaCodingAgentIndex: 41,
        sweBenchPro: 97.7,
      },
      outputTokensPerSecond: 42.4,
      outputTokensPerTask: 39666,
      efforts: {
        max: {
          aaSlug: "kimi-k3",
          scores: {
            aaCodingAgentIndex: 41,
            sweBenchPro: 97.7,
          },
          outputTokensPerSecond: 42.4,
        },
        low: {
          aaSlug: "kimi-k3-low",
          scores: {
            aaIntelligenceIndex: 17,
          },
          outputTokensPerSecond: 38,
          outputTokensPerTask: 39666,
        },
      },
      price: {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cachedInputPerMTok: 0.3,
        cacheWritePerMTok: 3,
      },
    },
    {
      id: "k3.1-pro",
      label: "Kimi K3.1 Pro",
      aaSlug: "kimi-k3-1-pro",
      scores: {
        aaIntelligenceIndex: 46,
      },
      outputTokensPerSecond: 31.9,
      fastOutputTokensPerSecond: 65.2,
      outputTokensPerTask: 72239,
      efforts: {
        default: {
          aaSlug: "kimi-k3-1-pro",
          scores: {
            aaIntelligenceIndex: 46,
          },
          outputTokensPerSecond: 31.9,
          outputTokensPerTask: 72239,
        },
      },
      price: {
        inputPerMTok: 2,
        outputPerMTok: 10,
        cachedInputPerMTok: 0.2,
        cacheWritePerMTok: 2,
      },
    },
    {
      id: "glm-5.3",
      label: "GLM-5.3",
      aaSlug: "glm-5-3",
      scores: {
        aaIntelligenceIndex: 32,
        aaCodingAgentIndex: 49,
        terminalBench: 41.21,
        sweBenchPro: 95.6,
      },
      outputTokensPerSecond: 66.5,
      outputTokensPerTask: 118987,
      efforts: {
        max: {
          aaSlug: "glm-5-3",
          scores: {
            aaIntelligenceIndex: 32,
            aaCodingAgentIndex: 49,
            terminalBench: 41.21,
            sweBenchPro: 95.6,
          },
          outputTokensPerSecond: 66.5,
          outputTokensPerTask: 118987,
        },
        low: {
          aaSlug: "glm-5-3-low",
          scores: {
            aaIntelligenceIndex: 23,
          },
          outputTokensPerSecond: 56.5,
          outputTokensPerTask: 51986,
        },
      },
      price: {
        inputPerMTok: 1.4,
        outputPerMTok: 4.4,
        cachedInputPerMTok: 0.26,
      },
    },
    {
      id: "glm-5.3-flash",
      label: "GLM-5.3-Flash",
      aaSlug: "glm-5-3-flash",
      scores: {
        aaIntelligenceIndex: 28,
        terminalBench: 35.45,
      },
      outputTokensPerTask: 134205,
      efforts: {
        none: {
          scores: {
            terminalBench: 35.45,
          },
        },
        default: {
          aaSlug: "glm-5-3-flash",
          scores: {
            aaIntelligenceIndex: 28,
          },
          outputTokensPerTask: 134205,
        },
      },
      price: {
        inputPerMTok: 0.15,
        outputPerMTok: 0.5,
        cachedInputPerMTok: 0.03,
      },
    },
    {
      id: "deepseek-v4.1-flash",
      label: "DeepSeek V4.1 Flash",
      aaSlug: "deepseek-v4-1-flash-1017",
      scores: {
        aaIntelligenceIndex: 33,
        aaCodingAgentIndex: 46,
      },
      outputTokensPerTask: 138962,
      efforts: {
        max: {
          aaSlug: "deepseek-v4-1-flash-1017",
          scores: {
            aaIntelligenceIndex: 33,
            aaCodingAgentIndex: 46,
          },
          outputTokensPerTask: 138962,
        },
        high: {
          aaSlug: "deepseek-v4-1-flash-1017-high",
          scores: {
            aaIntelligenceIndex: 29,
          },
          outputTokensPerTask: 110430,
        },
        none: {
          aaSlug: "deepseek-v4-1-flash-1017-non-reasoning",
          scores: {
            aaIntelligenceIndex: 19,
          },
          outputTokensPerTask: 65358,
        },
      },
      price: {
        inputPerMTok: 0.3,
        outputPerMTok: 1.2,
        cachedInputPerMTok: 0.006,
      },
    },
    {
      id: "qwen3.8-flash-next",
      label: "Qwen 3.8 Flash Next",
      scores: {},
      price: {
        inputPerMTok: 0.15,
        outputPerMTok: 0.47,
        cachedInputPerMTok: 0.016,
        cacheWritePerMTok: 0.2,
      },
    },
    {
      id: "qwen4-max",
      label: "Qwen4 Max",
      aliases: ["qwen-latest-series-invite", "qwen4-max-preview", "qwen4.0-max-preview"],
      aaSlug: "qwen4-max",
      scores: {
        aaIntelligenceIndex: 42.8914543287565,
      },
      outputTokensPerTask: 104940,
      efforts: {
        xhigh: {
          aaSlug: "qwen4-max",
          scores: {
            aaIntelligenceIndex: 42.8914543287565,
          },
          outputTokensPerTask: 104940,
        },
      },
    },
    {
      id: "gemini-4-carbon",
      label: "Gemini 4 Carbon",
      aaSlug: "gemini-4-carbon",
      scores: {
        aaIntelligenceIndex: 60,
        aaCodingAgentIndex: 59,
      },
      outputTokensPerSecond: 78.7,
      outputTokensPerTask: 122768,
      efforts: {
        high: {
          aaSlug: "gemini-4-carbon",
          scores: {
            aaIntelligenceIndex: 60,
            aaCodingAgentIndex: 59,
          },
          outputTokensPerSecond: 78.7,
          outputTokensPerTask: 122768,
        },
        medium: {
          aaSlug: "gemini-4-carbon-medium",
          scores: {
            aaIntelligenceIndex: 58,
          },
          outputTokensPerSecond: 72,
          outputTokensPerTask: 103012,
        },
        low: {
          aaSlug: "gemini-4-carbon-low",
          scores: {
            aaIntelligenceIndex: 54,
          },
          outputTokensPerSecond: 63.4,
          outputTokensPerTask: 86165,
        },
      },
      price: {
        inputPerMTok: 2,
        outputPerMTok: 10,
        cachedInputPerMTok: 0.1,
      },
    },
    {
      id: "mistral-large-4",
      label: "Mistral Large 4",
      aaSlug: "mistral-large-4",
      scores: {
        aaIntelligenceIndex: 26,
        aaCodingAgentIndex: 35,
      },
      outputTokensPerSecond: 109,
      outputTokensPerTask: 81951,
      efforts: {
        high: {
          aaSlug: "mistral-large-4",
          scores: {
            aaIntelligenceIndex: 26,
            aaCodingAgentIndex: 35,
          },
          outputTokensPerSecond: 109,
          outputTokensPerTask: 81951,
        },
        medium: {
          aaSlug: "mistral-large-4-medium",
          scores: {
            aaIntelligenceIndex: 23,
          },
          outputTokensPerSecond: 104.9,
          outputTokensPerTask: 56324,
        },
      },
      price: {
        inputPerMTok: 0.7,
        outputPerMTok: 2.1,
        cachedInputPerMTok: 0.07,
      },
    },
    {
      id: "mistral-medium-3.5",
      label: "Mistral Medium 3.5",
      aaSlug: "mistral-medium-3-5",
      scores: {
        aaIntelligenceIndex: 5,
      },
      outputTokensPerSecond: 135.4,
      outputTokensPerTask: 39528,
      efforts: {
        default: {
          aaSlug: "mistral-medium-3-5",
          scores: {
            aaIntelligenceIndex: 5,
          },
          outputTokensPerSecond: 135.4,
          outputTokensPerTask: 39528,
        },
      },
    },
    {
      id: "muse-wonder-1.0",
      label: "Muse Wonder 1.0",
      aaSlug: "muse-wonder",
      scores: {
        aaIntelligenceIndex: 44,
        aaCodingAgentIndex: 52,
        sweBenchPro: 96.73,
      },
      outputTokensPerSecond: 123.4,
      outputTokensPerTask: 96063,
      efforts: {
        xhigh: {
          scores: {
            sweBenchPro: 96.73,
          },
        },
        max: {
          aaSlug: "muse-wonder",
          scores: {
            aaIntelligenceIndex: 44,
            aaCodingAgentIndex: 52,
          },
          outputTokensPerSecond: 123.4,
          outputTokensPerTask: 96063,
        },
        high: {
          aaSlug: "muse-wonder-high",
          scores: {
            aaIntelligenceIndex: 41,
          },
          outputTokensPerSecond: 122.8,
          outputTokensPerTask: 67927,
        },
      },
      price: {
        inputPerMTok: 4,
        outputPerMTok: 20,
        cachedInputPerMTok: 0.2,
      },
    },
    {
      id: "muse-spark-1.3",
      label: "Muse Spark 1.3",
      aaSlug: "muse-spark-1-3",
      scores: {
        aaIntelligenceIndex: 37,
        aaCodingAgentIndex: 46,
        terminalBench: 14.85,
      },
      outputTokensPerSecond: 125.6,
      outputTokensPerTask: 91114,
      efforts: {
        xhigh: {
          aaSlug: "muse-spark-1-3-xhigh",
          scores: {
            terminalBench: 14.85,
          },
          outputTokensPerSecond: 223.9,
        },
        max: {
          aaSlug: "muse-spark-1-3",
          scores: {
            aaIntelligenceIndex: 37,
            aaCodingAgentIndex: 46,
          },
          outputTokensPerSecond: 125.6,
          outputTokensPerTask: 91114,
        },
      },
      price: {
        inputPerMTok: 1.25,
        outputPerMTok: 4.25,
        cachedInputPerMTok: 0.15,
      },
    },
    {
      id: "muse-ember-1.0",
      label: "Muse Ember 1.0",
      aaSlug: "muse-ember",
      scores: {
        aaIntelligenceIndex: 36,
      },
      outputTokensPerSecond: 425,
      outputTokensPerTask: 84482,
      efforts: {
        max: {
          aaSlug: "muse-ember",
          scores: {
            aaIntelligenceIndex: 36,
          },
          outputTokensPerSecond: 425,
          outputTokensPerTask: 84482,
        },
        xhigh: {
          aaSlug: "muse-ember-xhigh",
          scores: {
            aaIntelligenceIndex: 34,
          },
          outputTokensPerSecond: 419,
          outputTokensPerTask: 72365,
        },
      },
      price: {
        inputPerMTok: 0.1,
        outputPerMTok: 0.5,
        cachedInputPerMTok: 0.004,
      },
    },
    {
      id: "muse-wonder-full-1.0",
      label: "Muse Wonder Full 1.0",
      aaSlug: "muse-wonder-full",
      scores: {
        aaIntelligenceIndex: 50,
      },
      outputTokensPerTask: 88476,
      efforts: {
        max: {
          aaSlug: "muse-wonder-full",
          scores: {
            aaIntelligenceIndex: 50,
          },
          outputTokensPerTask: 88476,
        },
      },
    },
    {
      id: "nanbeige4.3-33b",
      label: "Nanbeige4.3-33B",
      aaSlug: "nanbeige4-3-33b",
      scores: {},
      outputTokensPerTask: 158458,
      efforts: {
        default: {
          aaSlug: "nanbeige4-3-33b",
          outputTokensPerTask: 158458,
        },
      },
    },
    {
      id: "qwen3.8-max",
      label: "Qwen3.8 Max",
      aaSlug: "qwen3-8-max",
      scores: {
        aaIntelligenceIndex: 34,
      },
      outputTokensPerTask: 170794,
      efforts: {
        xhigh: {
          aaSlug: "qwen3-8-max",
          scores: {
            aaIntelligenceIndex: 34,
          },
          outputTokensPerTask: 170794,
        },
      },
    },
    {
      id: "gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      aaSlug: "gemini-3-8-flash",
      scores: {
        aaIntelligenceIndex: 31,
      },
      outputTokensPerTask: 98940,
      efforts: {
        high: {
          aaSlug: "gemini-3-8-flash",
          scores: {
            aaIntelligenceIndex: 31,
          },
          outputTokensPerTask: 98940,
        },
        medium: {
          aaSlug: "gemini-3-8-flash-medium",
          scores: {
            aaIntelligenceIndex: 30,
          },
          outputTokensPerTask: 82068,
        },
      },
    },
    {
      id: "gemini-4-argon",
      label: "Gemini 4 Argon",
      aaSlug: "gemini-4-argon",
      scores: {
        aaIntelligenceIndex: 50,
      },
      outputTokensPerTask: 116368,
      efforts: {
        high: {
          aaSlug: "gemini-4-argon",
          scores: {
            aaIntelligenceIndex: 50,
          },
          outputTokensPerTask: 116368,
        },
        medium: {
          aaSlug: "gemini-4-argon-medium",
          scores: {
            aaIntelligenceIndex: 48,
          },
          outputTokensPerTask: 100407,
        },
      },
    },
    {
      id: "gemini-4-hydrogen",
      label: "Gemini 4 Hydrogen",
      aaSlug: "gemini-4-hydrogen",
      scores: {
        aaIntelligenceIndex: 54,
      },
      outputTokensPerTask: 154406,
      efforts: {
        xhigh: {
          aaSlug: "gemini-4-hydrogen",
          scores: {
            aaIntelligenceIndex: 54,
          },
          outputTokensPerTask: 154406,
        },
        medium: {
          aaSlug: "gemini-4-hydrogen-medium",
          scores: {
            aaIntelligenceIndex: 41,
          },
          outputTokensPerTask: 39353,
        },
      },
    },
    {
      id: "gemini-3-8-flash-medium",
      label: "Gemini 3.8 Flash (Medium)",
      aaSlug: "gemini-3-8-flash-medium",
      scores: {
        aaIntelligenceIndex: 30,
      },
      outputTokensPerTask: 82068,
    },
    {
      id: "gemini-4-argon-medium",
      label: "Gemini 4 Argon (Medium)",
      aaSlug: "gemini-4-argon-medium",
      scores: {
        aaIntelligenceIndex: 48,
      },
      outputTokensPerTask: 100407,
    },
    {
      id: "gemini-4-hydrogen-medium",
      label: "Gemini 4 Hydrogen (Medium)",
      aaSlug: "gemini-4-hydrogen-medium",
      scores: {
        aaIntelligenceIndex: 41,
      },
      outputTokensPerTask: 39353,
    },
    {
      id: "claude-fable-5-1-medium",
      label: "Claude Fable 5.1 (Medium)",
      aaSlug: "claude-fable-5-1-medium",
      scores: {
        aaIntelligenceIndex: 43,
      },
      outputTokensPerTask: 48545,
    },
    {
      id: "deepseek-v4-pro-high",
      label: "DeepSeek V4 Pro (High)",
      aaSlug: "deepseek-v4-pro-high",
      scores: {
        aaIntelligenceIndex: 21,
      },
      outputTokensPerTask: 70314,
    },
    {
      id: "gemini-4-neon",
      label: "Gemini 4 Neon",
      aaSlug: "gemini-4-neon",
      scores: {
        aaIntelligenceIndex: 61,
      },
      outputTokensPerTask: 141631,
      efforts: {
        xhigh: {
          aaSlug: "gemini-4-neon",
          scores: {
            aaIntelligenceIndex: 61,
          },
          outputTokensPerTask: 141631,
        },
        high: {
          aaSlug: "gemini-4-neon-high",
          scores: {
            aaIntelligenceIndex: 60,
          },
          outputTokensPerTask: 90188,
        },
      },
    },
    {
      id: "gemini-4-neon-high",
      label: "Gemini 4 Neon (High)",
      aaSlug: "gemini-4-neon-high",
      scores: {
        aaIntelligenceIndex: 60,
      },
      outputTokensPerTask: 90188,
    },
  ],
};
