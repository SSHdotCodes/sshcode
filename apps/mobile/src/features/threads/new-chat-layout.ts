export function resolveNewChatLayout(input: {
  readonly platform: string;
  readonly windowHeight: number;
  readonly showsDashboard: boolean;
  readonly fontScale?: number;
  readonly composerTop?: number | null;
  readonly isProjectDraft?: boolean;
}) {
  const ios = input.platform === "ios";
  const compactNewChatLayout = ios && input.windowHeight < 740;
  const restingHeroHeight =
    ios && input.composerTop != null ? Math.max(0, input.composerTop - 12) : null;
  // The project prompt spans two lines and needs room for the machine below it.
  const compactProjectHero =
    input.isProjectDraft === true &&
    (compactNewChatLayout || (restingHeroHeight !== null && restingHeroHeight < 316));
  const compactProjectMascotSize =
    (input.fontScale ?? 1) >= 1.25 || (restingHeroHeight !== null && restingHeroHeight < 250)
      ? 0
      : 60;
  return {
    compactNewChatLayout,
    compactDashboard: input.showsDashboard && compactNewChatLayout,
    compactProjectHero,
    editorMinHeight: compactNewChatLayout ? 40 : 72,
    composerMinHeight: compactNewChatLayout ? 104 : 140,
    composerPaddingTop: compactNewChatLayout ? 12 : 14,
    heroSize: compactProjectHero ? compactProjectMascotSize : compactNewChatLayout ? 70 : 96,
    heroViewportHeight: input.showsDashboard ? restingHeroHeight : null,
  };
}
