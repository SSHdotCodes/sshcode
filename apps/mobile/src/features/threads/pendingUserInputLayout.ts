const PENDING_USER_INPUT_MAX_HEIGHT = 560;
const PENDING_USER_INPUT_MIN_HEIGHT = 160;
const PENDING_USER_INPUT_VERTICAL_GAP = 12;

/**
 * One clock for the questionnaire expand/collapse choreography: the card's
 * enter/exit and the feed-inset glide must share it or they visibly drift.
 * Sized for the near-full-height slide (the card travels its own height),
 * in the same class as the iOS keyboard's ~250ms.
 */
export const USER_INPUT_TOGGLE_DURATION_MS = 220;

export function derivePendingUserInputMaxHeight(input: {
  readonly windowHeight: number;
  readonly keyboardHeight: number;
  readonly navigationHeaderHeight: number;
  readonly composerOverlapHeight: number;
}): number {
  "worklet";
  const availableHeight =
    input.windowHeight -
    Math.max(0, input.keyboardHeight) -
    Math.max(0, input.navigationHeaderHeight) -
    Math.max(0, input.composerOverlapHeight) -
    PENDING_USER_INPUT_VERTICAL_GAP;

  return Math.min(
    PENDING_USER_INPUT_MAX_HEIGHT,
    Math.max(PENDING_USER_INPUT_MIN_HEIGHT, availableHeight),
  );
}

/**
 * A blocking question (a harness callback the run waits on) takes the
 * composer's place. An async one, answered by message while the agent keeps
 * working (`ask_user`, Codex's async questions), sits above the composer and
 * leaves it usable.
 */
/**
 * Vertical padding and the two gaps around the scrolling questions.
 * Mobile's rem is 14px: `p-4` is 1rem and `gap-2.5` is 0.625rem.
 */
export const QUESTION_CARD_VERTICAL_CHROME = 14 * 2 + 14 * 0.625 * 2;

/**
 * Height left for the question list once the header and send button are pinned.
 * The list has to be a real scroll viewport: a max height on the card alone
 * clips the custom answer under the keyboard instead of scrolling it up.
 */
export function questionScrollMaxHeight(input: {
  readonly cardMaxHeight: number;
  readonly headerHeight: number;
  readonly footerHeight: number;
}): number {
  "worklet";
  return Math.max(
    0,
    input.cardMaxHeight -
      QUESTION_CARD_VERTICAL_CHROME -
      Math.max(0, input.headerHeight) -
      Math.max(0, input.footerHeight),
  );
}

export function userInputOwnsComposer(
  pendingUserInput: { readonly responseMode?: "message" } | null | undefined,
): boolean {
  return pendingUserInput != null && pendingUserInput.responseMode !== "message";
}
