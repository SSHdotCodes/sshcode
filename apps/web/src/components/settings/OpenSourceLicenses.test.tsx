import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The page frame reads the router; the panel's own content is what is under test.
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: (props: { children: ReactNode }) => props.children,
  SettingsSection: (props: { children: ReactNode; headerAction?: ReactNode }) => (
    <>
      {props.headerAction}
      {props.children}
    </>
  ),
}));

import { OpenSourceLicensesPanel } from "./OpenSourceLicenses";

const manifest = {
  schemaVersion: 1,
  entries: [
    {
      name: "left-pad",
      version: "1.3.0",
      license: "MIT",
      bundles: ["web"],
      noticeText: "MIT License",
      kind: "package",
      sourceUrl: null,
    },
  ],
};

function respond(body: string, contentType: string) {
  return Promise.resolve(
    new Response(body, { status: 200, headers: { "content-type": contentType } }),
  );
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

describe("OpenSourceLicensesPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says plainly that the list did not load, then loads it on Try again", async () => {
    const fetch = vi
      .fn()
      // A dev server answers a missing file with the app's HTML page.
      .mockImplementationOnce(() => respond("<!doctype html><html></html>", "text/html"))
      .mockImplementationOnce(() => respond(JSON.stringify(manifest), "application/json"));
    vi.stubGlobal("fetch", fetch);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<OpenSourceLicensesPanel />);
    });
    await settle();

    expect(text(renderer)).toContain("Couldn't load the license list.");
    expect(text(renderer)).not.toContain("Unexpected token");
    expect(text(renderer)).not.toContain("JSON");

    const tryAgain = renderer.root.findAll(
      (node) =>
        node.props.onClick !== undefined && JSON.stringify(node.props.children) === '"Try again"',
    )[0];
    await act(async () => {
      tryAgain!.props.onClick();
    });
    await settle();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(text(renderer)).toContain("left-pad");
    expect(text(renderer)).not.toContain("Couldn't load the license list.");
    act(() => renderer.unmount());
  });
});
