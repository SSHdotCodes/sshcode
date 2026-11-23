import { describe, expect, it } from "@effect/vitest";

import * as ErrorLoop from "./ErrorLoop.ts";

const MINUTE = 60_000;

/** One Modal container crash, shaped like the incident log: ids change per attempt. */
const crash = (attempt: number) => [
  "Traceback (most recent call last):",
  '  File "/pkg/modal/_container_entrypoint.py", line 362, in hydrate_function',
  "    service = get_function_service(function_def, _client)",
  '  File "<frozen importlib._bootstrap>", line 1324, in _find_and_load_unlocked',
  "ModuleNotFoundError: No module named 'train'",
  `Function fu-4pkLqHwJRQdvrYFnMI4eY${attempt} failed during startup.`,
  `Runner failed with exception: ModuleNotFoundError("No module named 'train'")`,
];

/** Feeds `rounds` at the given minutes and returns each wake with when it came. */
const replay = (
  detector: ReturnType<typeof ErrorLoop.makeDetector>,
  rounds: ReadonlyArray<readonly [minute: number, lines: ReadonlyArray<string>]>,
) =>
  rounds.flatMap(([minute, lines]) => {
    detector.observe(lines, minute * MINUTE);
    const wake = detector.take(minute * MINUTE);
    return wake === undefined ? [] : [{ minute, summary: ErrorLoop.loopSummary(wake) }];
  });

describe("ErrorLoop", () => {
  it("wakes once for an error that keeps repeating, naming the line, count and span", () => {
    const wakes = replay(
      ErrorLoop.makeDetector({ rewake: true }),
      [0, 4, 8, 12, 16, 20, 24].map((minute, attempt) => [minute, crash(attempt)] as const),
    );
    // The third crash only arms it; the fourth, still failing minutes later, wakes.
    expect(wakes).toEqual([
      {
        minute: 12,
        summary:
          "still running, same error 4× in 12 min: ModuleNotFoundError: No module named 'train'",
      },
    ]);
  });

  it("re-wakes once when the same error still repeats 30 minutes later", () => {
    const minutes = Array.from({ length: 30 }, (_, index) => index * 4);
    const rounds = minutes.map((minute, attempt) => [minute, crash(attempt)] as const);
    expect(
      replay(ErrorLoop.makeDetector({ rewake: true }), rounds).map((wake) => wake.minute),
    ).toEqual([12, 44]);
    // Watchers that already wake on all their output get one wake per error line.
    expect(
      replay(ErrorLoop.makeDetector({ rewake: false }), rounds).map((wake) => wake.minute),
    ).toEqual([12]);
  });

  it("wakes again for a different error, not for lines the first loop printed with it", () => {
    const detector = ErrorLoop.makeDetector({ rewake: true });
    const refused = (port: number) => [`Error: connect ECONNREFUSED 127.0.0.1:${port}`];
    const wakes = replay(detector, [
      ...[0, 1, 2, 5].map((minute, attempt) => [minute, crash(attempt)] as const),
      [6, crash(4)],
      [7, crash(5)],
      ...[8, 9, 10, 13].map((minute) => [minute, refused(5000 + minute)] as const),
    ]);
    expect(wakes.map((wake) => wake.minute)).toEqual([5, 13]);
    expect(wakes[1]!.summary).toBe(
      "still running, same error 4× in 5 min: Error: connect ECONNREFUSED 127.0.0.1:5013",
    );
  });

  it("does not wake for two occurrences, a burst, or a retry that recovered", () => {
    // Twice, an hour apart.
    expect(
      replay(ErrorLoop.makeDetector({ rewake: true }), [
        [0, crash(0)],
        [60, crash(1)],
      ]),
    ).toEqual([]);
    // Eight workers failing on the same import at once, then quiet.
    const burst = Array.from({ length: 8 }, () => crash(0)).flat();
    expect(
      replay(ErrorLoop.makeDetector({ rewake: true }), [
        [0, burst],
        [30, ["still waiting on workers"]],
      ]),
    ).toEqual([]);
    // A queue worker's DNS blip: repeated within a minute, then back to work.
    const dns = "fatal: unable to access 'https://example.test/': Could not resolve host";
    expect(
      replay(ErrorLoop.makeDetector({ rewake: true }), [
        [0, [dns, dns]],
        [1, [dns, dns]],
        ...Array.from(
          { length: 20 },
          (_, index) => [2 + index, ['{"done": 8, "err": 0}']] as const,
        ),
      ]),
    ).toEqual([]);
  });

  it("stays quiet on noisy build, training and test output seen in real job logs", () => {
    const detector = ErrorLoop.makeDetector({ rewake: true });
    const warning = [
      "/opt/venv/lib/python3.12/site-packages/triton/compiler.py:504: UserWarning: TRITON_F32_DEFAULT is unset: defaulting to FP fusion ENABLED",
      "  warn_once(msg)",
    ];
    const rounds: Array<readonly [number, ReadonlyArray<string>]> = [
      [
        0,
        [
          "=> Step 1: RUN python -m pip install torch==2.15.0",
          "Saving image...",
          "Built image in 1.79s",
        ],
      ],
      ...Array.from(
        { length: 40 },
        (_, index) => [1 + index, [...warning, `step ${index} loss 0.4`]] as const,
      ),
      // A suite whose failures differ per test, then a summary.
      [
        42,
        [
          " FAIL  src/a.test.ts > parses dates",
          "AssertionError: expected '2026-11-21' to be '2026-11-22'",
          " FAIL  src/b.test.ts > merges rows",
          "AssertionError: expected [ 1, 2 ] to deeply equal [ 1, 2, 3 ]",
          " Test Files  2 failed | 40 passed (42)",
        ],
      ],
      // An eval batch where tasks fail with the same rate limit for under two minutes.
      ...Array.from(
        { length: 15 },
        (_, index) =>
          [
            43 + index / 10,
            [
              `{"task": "tx22-${index}", "mode": "pos", "ok_expectation": false, "secs": 0.4, "error": "HTTPStatusError: Client error '429 Too Many Requests'"}`,
            ],
          ] as const,
      ),
    ];
    expect(replay(detector, rounds)).toEqual([]);
  });

  it("resumes from a saved snapshot without waking twice", () => {
    const before = ErrorLoop.makeDetector({ rewake: true });
    expect(
      replay(before, [
        [0, crash(0)],
        [1, crash(1)],
      ]),
    ).toEqual([]);
    // The restart keeps the count: the third and a confirming fourth wake.
    const resumed = ErrorLoop.makeDetector({ rewake: true, saved: before.snapshot() });
    expect(
      replay(resumed, [
        [2, crash(2)],
        [5, crash(3)],
      ]).map((wake) => wake.minute),
    ).toEqual([5]);
    const again = ErrorLoop.makeDetector({ rewake: true, saved: resumed.snapshot() });
    expect(
      replay(again, [
        [6, crash(4)],
        [9, crash(5)],
      ]),
    ).toEqual([]);
  });

  it("names one error class for lines that differ only in times, ids, numbers and paths", () => {
    const keys = [
      "2026-11-21T20:21:04Z ERROR worker 7 failed: job 3f9a2c1e-1111-4222-8333-444455556666 at /tmp/run-91af/train.py:12",
      "2026-11-21T20:25:41Z ERROR worker 12 failed: job 0b1c2d3e-aaaa-4bbb-8ccc-ddddeeeeffff at /tmp/run-77c2/train.py:40",
    ].map(ErrorLoop.normalizeErrorLine);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe("<time> error worker # failed: job <id> at …/train.py:#");
  });

  it("redacts credentials and long tokens from lines shown in a wake", () => {
    expect(
      ErrorLoop.displayLine(
        "\u001b[31mError: 401 for https://user:hunter2@api.example.test?token=abc123 Authorization: Bearer sk-ant-api03-AbCdEf0123456789xyz\u001b[0m",
      ),
    ).toBe(
      "Error: 401 for https://<redacted>@api.example.test?token=<redacted> Authorization: Bearer <redacted>",
    );
    expect(ErrorLoop.displayLine(`HF_TOKEN=hf_${"a1".repeat(17)} failed`)).toBe(
      "HF_TOKEN=<redacted> failed",
    );
    expect(ErrorLoop.displayLine("x".repeat(300))).toHaveLength(120);
    expect(ErrorLoop.lastOutputLine("epoch 1\n  \nloss 0.31 12%\rloss 0.30 13%\r\n\n")).toBe(
      "loss 0.30 13%",
    );
  });

  it("counts a job overdue at the later of 1.5× and ten minutes past its expected duration", () => {
    expect(ErrorLoop.overdueAfterMs(5)).toBe(15 * MINUTE);
    expect(ErrorLoop.overdueAfterMs(60)).toBe(90 * MINUTE);
  });
});
