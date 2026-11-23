import { describe, expect, it } from "vite-plus/test";

import { derivePendingUserInputMaxHeight, questionScrollMaxHeight } from "./pendingUserInputLayout";

describe("derivePendingUserInputMaxHeight", () => {
  it("leaves the question visible above iPhone tabs until the keyboard opens", () => {
    const phone = {
      windowHeight: 874,
      navigationHeaderHeight: 116,
      composerOverlapHeight: 199,
    };
    expect(derivePendingUserInputMaxHeight({ ...phone, keyboardHeight: 0 })).toBe(547);
    expect(derivePendingUserInputMaxHeight({ ...phone, keyboardHeight: 336 })).toBe(211);
  });

  it("caps a tall portrait viewport", () => {
    expect(
      derivePendingUserInputMaxHeight({
        windowHeight: 932,
        keyboardHeight: 0,
        navigationHeaderHeight: 103,
        composerOverlapHeight: 94,
      }),
    ).toBe(560);
  });

  it("subtracts the keyboard while editing a custom answer", () => {
    expect(
      derivePendingUserInputMaxHeight({
        windowHeight: 932,
        keyboardHeight: 336,
        navigationHeaderHeight: 103,
        composerOverlapHeight: 94,
      }),
    ).toBe(387);
  });

  it("leaves a scroll viewport for the custom answer when the keyboard is open", () => {
    const phone = {
      windowHeight: 874,
      navigationHeaderHeight: 116,
      composerOverlapHeight: 199,
    };
    const cardMaxHeight = derivePendingUserInputMaxHeight({ ...phone, keyboardHeight: 336 });
    const scrollHeight = questionScrollMaxHeight({
      cardMaxHeight,
      headerHeight: 44,
      footerHeight: 52,
    });

    expect(cardMaxHeight).toBe(211);
    expect(scrollHeight).toBeGreaterThanOrEqual(54);
  });

  it("keeps the fixed action area usable in a short keyboard-open viewport", () => {
    expect(
      derivePendingUserInputMaxHeight({
        windowHeight: 375,
        keyboardHeight: 240,
        navigationHeaderHeight: 44,
        composerOverlapHeight: 94,
      }),
    ).toBe(160);
  });
});
