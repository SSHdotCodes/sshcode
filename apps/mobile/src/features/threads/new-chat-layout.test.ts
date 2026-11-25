import { expect, it } from "vite-plus/test";
import { resolveNewChatLayout } from "./new-chat-layout";

it("keeps the compact iPhone editor, composer, and hero sizes when the keyboard hides the cards", () => {
  const phone = { platform: "ios", windowHeight: 667 };
  const resting = resolveNewChatLayout({ ...phone, showsDashboard: true });
  const typing = resolveNewChatLayout({ ...phone, showsDashboard: false });

  expect(resting).toEqual({
    compactNewChatLayout: true,
    compactDashboard: true,
    compactProjectHero: false,
    editorMinHeight: 40,
    composerMinHeight: 104,
    composerPaddingTop: 12,
    heroSize: 70,
    heroViewportHeight: null,
  });
  expect(typing).toEqual({ ...resting, compactDashboard: false });
});

it.each([
  ["ios", 740],
  ["ios", 956],
  ["android", 667],
])("uses standard dimensions on %s at %d points", (platform, windowHeight) => {
  expect(resolveNewChatLayout({ platform, windowHeight, showsDashboard: true })).toEqual({
    compactNewChatLayout: false,
    compactDashboard: false,
    compactProjectHero: false,
    editorMinHeight: 72,
    composerMinHeight: 140,
    composerPaddingTop: 14,
    heroSize: 96,
    heroViewportHeight: null,
  });
});

it("keeps the project hero above a tall composer without changing its size while typing", () => {
  const draft = { platform: "ios", windowHeight: 956, composerTop: 247, isProjectDraft: true };
  const resting = resolveNewChatLayout({ ...draft, showsDashboard: true });
  const typing = resolveNewChatLayout({ ...draft, showsDashboard: false });

  expect(resting).toMatchObject({
    heroViewportHeight: 235,
    compactProjectHero: true,
    heroSize: 0,
    composerMinHeight: 140,
  });
  expect(typing).toEqual({ ...resting, heroViewportHeight: null });
  expect(resolveNewChatLayout({ ...draft, composerTop: 380, showsDashboard: true })).toMatchObject({
    heroViewportHeight: 368,
    compactProjectHero: false,
    heroSize: 96,
  });
});

it("gives larger project titles the room used by the compact mascot", () => {
  const draft = {
    platform: "ios",
    windowHeight: 956,
    composerTop: 285,
    isProjectDraft: true,
    showsDashboard: true,
  };

  expect(resolveNewChatLayout(draft).heroSize).toBe(60);
  expect(resolveNewChatLayout({ ...draft, fontScale: 1.35 }).heroSize).toBe(0);
});
