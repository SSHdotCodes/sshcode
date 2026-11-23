import {
  WORKING_CYCLE_MS,
  WORKING_DASH_PATH,
  WORKING_DASH_TRACKS,
  WORKING_VARIATIONS,
} from "@t3tools/client-runtime/working-indicator-motion";
import { observeVisibleAnimation } from "../lib/visibleAnimation";

const dashStyles = WORKING_DASH_TRACKS.map((frames, index) => {
  const keyframes = frames
    .map(
      (frame) => `${(frame.time / WORKING_VARIATIONS) * 100}% {
        transform: translate(${frame.x}px, ${frame.y}px) rotate(${frame.rotation}deg);
        opacity: ${frame.opacity};
      }`,
    )
    .join("\n");
  return `@keyframes working-dash-${index} { ${keyframes} }
    [data-working-indicator] > g > g:nth-child(${index + 1}) {
      animation-name: working-dash-${index};
    }`;
}).join("\n");

const styles = `${dashStyles}
  @media (prefers-reduced-motion: no-preference) {
    [data-working-indicator] > g > g {
      animation-duration: ${WORKING_CYCLE_MS * WORKING_VARIATIONS}ms;
      animation-timing-function: cubic-bezier(.333333, 0, .666667, 1);
      animation-iteration-count: infinite;
      animation-play-state: var(--visible-animation-state, paused);
    }
  }`;

/** CSS moves only eight small SVG groups; the shared observer stops hidden rows. */
export function WorkingStatusIndicator({ className }: { readonly className?: string }) {
  return (
    <>
      {/* React hoists and deduplicates this stylesheet across every visible indicator. */}
      <style href="sshcode-working-indicator" precedence="default">
        {styles}
      </style>
      <svg
        ref={observeVisibleAnimation}
        data-working-indicator=""
        className={className}
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ overflow: "hidden" }}
      >
        <g transform="translate(12 12)">
          {WORKING_DASH_TRACKS.map((frames) => (
            <g
              key={frames[0]!.rotation}
              transform={`translate(${frames[0]!.x} ${frames[0]!.y}) rotate(${frames[0]!.rotation})`}
            >
              <path d={WORKING_DASH_PATH} />
            </g>
          ))}
        </g>
      </svg>
    </>
  );
}
