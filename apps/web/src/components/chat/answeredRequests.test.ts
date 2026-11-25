import { RuntimeRequestId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { forgetResolvedAnswers } from "./answeredRequests";

it("keeps an answered question hidden through partial and stale projections until its resolution arrives", () => {
  const first = RuntimeRequestId.make("first");
  const second = RuntimeRequestId.make("second");
  const receipts = new Set([first, second]);
  expect(forgetResolvedAnswers(receipts, [])).toBe(receipts);
  expect(forgetResolvedAnswers(receipts, [{ id: first, status: "pending" }])).toBe(receipts);
  expect(forgetResolvedAnswers(receipts, [{ id: first, status: "resolved" }])).toEqual(
    new Set([second]),
  );
});
