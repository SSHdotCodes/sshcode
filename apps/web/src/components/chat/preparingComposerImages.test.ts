import { describe, expect, it, vi } from "vite-plus/test";
import {
  addPreparingComposerImages,
  cancelPreparingComposerImages,
  countPreparingComposerImages,
  isPreparingComposerImage,
  prepareImageWhileActive,
  removePreparingComposerImages,
} from "./preparingComposerImages";

describe("preparing composer images", () => {
  it("cancels only the chosen image in its original draft and releases its reservation once", () => {
    const finishA = vi.fn();
    const finishB = vi.fn();
    const file = new File(["image"], "image.png", { type: "image/png" });
    addPreparingComposerImages("draft-a", [
      { id: "one", name: file.name, file, onFinish: finishA },
    ]);
    addPreparingComposerImages("draft-b", [
      { id: "two", name: file.name, file, onFinish: finishB },
    ]);
    expect(countPreparingComposerImages("draft-a")).toBe(1);
    expect(removePreparingComposerImages("draft-a", new Set(["one"]))).toEqual(new Set(["one"]));
    expect(isPreparingComposerImage("draft-a", "one")).toBe(false);
    expect(isPreparingComposerImage("draft-b", "two")).toBe(true);
    expect(removePreparingComposerImages("draft-a", new Set(["one"])).size).toBe(0);
    expect(finishA).toHaveBeenCalledTimes(1);
    expect(finishB).not.toHaveBeenCalled();
    removePreparingComposerImages("draft-b", new Set(["two"]));
    expect(finishB).toHaveBeenCalledTimes(1);
  });
  it("cancelling a target drops every preparing image and finishes each once", async () => {
    const file = new File(["image"], "image.png", { type: "image/png" });
    const first = { id: "first", name: file.name, file, onFinish: vi.fn() };
    const second = { id: "second", name: file.name, file, onFinish: vi.fn() };
    const other = { id: "other", name: file.name, file, onFinish: vi.fn() };
    let finish!: (file: File) => void;
    const compression = new Promise<File>((resolve) => {
      finish = resolve;
    });
    addPreparingComposerImages("draft-discarded", [first, second]);
    addPreparingComposerImages("draft-kept", [other]);
    const result = prepareImageWhileActive("draft-discarded", first, () => compression);

    cancelPreparingComposerImages("draft-discarded");
    cancelPreparingComposerImages("draft-discarded");

    expect(countPreparingComposerImages("draft-discarded")).toBe(0);
    expect(isPreparingComposerImage("draft-kept", "other")).toBe(true);
    expect(first.onFinish).toHaveBeenCalledTimes(1);
    expect(second.onFinish).toHaveBeenCalledTimes(1);
    expect(other.onFinish).not.toHaveBeenCalled();
    finish(file);
    expect(await result).toBeUndefined();
    removePreparingComposerImages("draft-kept", new Set(["other"]));
  });

  it("ignores a canceled image even if compression finishes later", async () => {
    const file = new File(["image"], "image.png", { type: "image/png" });
    const image = { id: "pending", name: file.name, file, onFinish: vi.fn() };
    let finish!: (file: File) => void;
    const compression = new Promise<File>((resolve) => {
      finish = resolve;
    });
    addPreparingComposerImages("draft-c", [image]);
    const result = prepareImageWhileActive("draft-c", image, () => compression);
    removePreparingComposerImages("draft-c", new Set([image.id]));
    finish(file);
    expect(await result).toBeUndefined();
    expect(image.onFinish).toHaveBeenCalledTimes(1);
  });
});
