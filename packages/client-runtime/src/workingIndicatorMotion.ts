/** Eight original circle dashes, in a 24-unit box. Each 3.2s phrase ends at rest. */
export const WORKING_CYCLE_MS = 3200;
export const WORKING_VARIATIONS = 3;
export const WORKING_DASH_PATH = "M-1.9 .182a10 10 0 0 1 3.8 0";

export interface WorkingDashPose {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly opacity: number;
}

interface WorkingDashFrame extends WorkingDashPose {
  readonly time: number;
}

function pose(angle: number, radius: number, tilt = 0, opacity = 1): WorkingDashPose {
  const radians = (angle * Math.PI) / 180;
  return {
    x: Math.sin(radians) * radius,
    y: -Math.cos(radians) * radius,
    rotation: angle + tilt,
    opacity,
  };
}

/** Precompute the choreography once. Only interpolation runs on the native UI thread. */
export const WORKING_DASH_TRACKS = Array.from({ length: 8 }, (_, index) => {
  const angle = index * 45;
  const rest = pose(angle, 10);
  const frames: WorkingDashFrame[] = [{ time: 0, ...rest }];
  for (let cycle = 0; cycle < WORKING_VARIATIONS; cycle++) {
    const direction = cycle === 1 ? -1 : 1;
    const wave = Math.sin((index * Math.PI) / 2 + cycle * 1.7);
    const stagger = ((index + cycle * 3) % 8) * 0.007;
    frames.push(
      { time: cycle + 0.09 + stagger, ...rest },
      {
        time: cycle + 0.3 + stagger,
        ...pose(angle + direction * (10 + wave * 7), 9.7 + wave * 0.7, wave * 34, 0.84),
      },
      {
        time: cycle + 0.51 + stagger,
        ...pose(
          angle + direction * (38 + wave * 10),
          7.9 + wave * 0.85,
          direction * (34 + wave * 20),
          0.72 + ((wave + 1) / 2) * 0.2,
        ),
      },
      {
        time: cycle + 0.7 + stagger,
        ...pose(angle + direction * (17 - wave * 9), 9.2 + wave * 0.9, -wave * 24, 0.9),
      },
      { time: cycle + 0.88 + stagger * 0.5, ...rest },
      { time: cycle + 1, ...rest },
    );
  }
  return frames;
});

/** Smoothstep matches CSS cubic-bezier(1/3, 0, 2/3, 1). Phase is in phrases, 0..3. */
export function sampleWorkingDash(
  frames: readonly WorkingDashFrame[],
  phase: number,
): WorkingDashPose {
  "worklet";
  const time = Math.max(0, Math.min(WORKING_VARIATIONS, phase));
  let index = Math.min(Math.floor(time) * 6, frames.length - 2);
  while (index < frames.length - 2 && time > frames[index + 1]!.time) index++;
  const from = frames[index]!;
  const to = frames[index + 1]!;
  const progress = Math.max(0, Math.min(1, (time - from.time) / (to.time - from.time)));
  const eased = progress * progress * (3 - 2 * progress);
  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased,
    rotation: from.rotation + (to.rotation - from.rotation) * eased,
    opacity: from.opacity + (to.opacity - from.opacity) * eased,
  };
}
