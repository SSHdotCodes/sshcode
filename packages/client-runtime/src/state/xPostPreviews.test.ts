import type { XPostPreview } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { loadXPostPreview, rememberedXPostPreview } from "./xPostPreviews.ts";

const card = (id: string): XPostPreview => ({
  url: `https://x.com/a/status/${id}`,
  authorName: "A",
  authorHandle: "a",
  text: id,
  createdAt: null,
  image: null,
});

it("looks a post up once and remembers found and missing posts", async () => {
  const read = vi.fn(async () => card("1"));
  const [first, second] = await Promise.all([
    loadXPostPreview("env:1", read),
    loadXPostPreview("env:1", read),
  ]);
  expect(first).toEqual(card("1"));
  expect(second).toEqual(card("1"));
  expect(read).toHaveBeenCalledTimes(1);
  expect(rememberedXPostPreview("env:1")).toEqual(card("1"));

  expect(rememberedXPostPreview("env:2")).toBeUndefined();
  await loadXPostPreview("env:2", async () => null);
  expect(rememberedXPostPreview("env:2")).toBeNull();
});

it("does not remember a failed call", async () => {
  expect(await loadXPostPreview("env:3", async () => undefined)).toBeUndefined();
  expect(
    await loadXPostPreview("env:3", () => Promise.reject(new Error("offline"))),
  ).toBeUndefined();
  expect(rememberedXPostPreview("env:3")).toBeUndefined();
  expect(await loadXPostPreview("env:3", async () => card("3"))).toEqual(card("3"));
});

it("stays small", async () => {
  for (let index = 0; index < 205; index += 1)
    await loadXPostPreview(`cap:${index}`, async () => card(String(index)));
  expect(rememberedXPostPreview("cap:0")).toBeUndefined();
  expect(rememberedXPostPreview("cap:204")).toEqual(card("204"));
});
