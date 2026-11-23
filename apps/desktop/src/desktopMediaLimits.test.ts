import { assert, describe, it } from "@effect/vitest";
import { DESKTOP_MEDIA_MAX_BYTES as CONTRACTS_LIMIT } from "@t3tools/contracts";

import { DESKTOP_MEDIA_MAX_BYTES } from "./desktopMediaLimits.ts";

describe("desktop media limits", () => {
  it("matches the contracts limit", () => {
    assert.strictEqual(DESKTOP_MEDIA_MAX_BYTES, CONTRACTS_LIMIT);
  });
});
