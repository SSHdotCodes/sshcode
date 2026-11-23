import type { SVGProps } from "react";

/** SSHCode's mark: an S at a prompt cursor, drawn like the app icon (assets/prod/app-icon.icon). */
export function AppMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="22.75 26.75 80.5 74.5" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M62.34 41.05A17.5 15 0 1 0 47.50 64.00A17.5 15 0 1 1 32.66 86.95"
        fill="none"
        stroke="currentColor"
        strokeWidth={14.5}
        strokeLinecap="round"
      />
      <rect x={79.25} y={91.75} width={24} height={9.5} rx={2.5} fill="currentColor" />
    </svg>
  );
}
