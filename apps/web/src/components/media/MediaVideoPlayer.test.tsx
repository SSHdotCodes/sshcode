import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MediaVideoPlayer } from "./MediaVideoPlayer";

describe("MediaVideoPlayer failure", () => {
  it("keeps the player's slot in a viewer", () => {
    const html = renderToStaticMarkup(
      <MediaVideoPlayer src={null} sourceFailed label="clip.mp4" />,
    );
    expect(html).toContain("Video unavailable · clip.mp4");
    expect(html).toContain("aspect-video");
  });

  it("is one short row in a transcript", () => {
    const html = renderToStaticMarkup(
      <MediaVideoPlayer src={null} sourceFailed compactFailure label="clip.mp4" />,
    );
    expect(html).toContain("Video unavailable · clip.mp4");
    expect(html).not.toContain("aspect-video");
    expect(html).not.toContain("min-h-28");
  });
});
