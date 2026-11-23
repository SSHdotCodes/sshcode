import { describe, expect, it } from "vite-plus/test";

import { stripClerkZxcvbnDictionary } from "./stripClerkZxcvbn";

describe("stripClerkZxcvbnDictionary", () => {
  it("replaces the inlined zxcvbn dictionary module body with empty exports", () => {
    const sample =
      'before(),9144(e,t,a){a.r(t),a.d(t,{adjacencyGraphs:()=>n,dictionary:()=>r});let r={diceware:"abacus,abdomen",passwords:"123456,password"};let n={qwerty:{"a":["q","s"]}}},8388(e,t,a){return 1}';

    const stripped = stripClerkZxcvbnDictionary(sample);

    expect(stripped).toBe(
      "before(),9144(e,t,a){a.r(t),a.d(t,{adjacencyGraphs:()=>({}),dictionary:()=>({})})},8388(e,t,a){return 1}",
    );
  });

  it("leaves unrelated modules unchanged", () => {
    const sample = "export const hello = 1;";
    expect(stripClerkZxcvbnDictionary(sample)).toBe(sample);
  });
});
