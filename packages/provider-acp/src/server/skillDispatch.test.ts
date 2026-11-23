import { describe, expect, it } from "@effect/vitest";

import { acpAdvertisedSkillNames, dispatchAcpSkillMention } from "./skillDispatch.ts";

const skills = new Set(["run-on-server", "nova"]);

describe("dispatchAcpSkillMention", () => {
  it("moves a picked or typed skill to the front as the agent's slash command", () => {
    expect(dispatchAcpSkillMention("Make a 3d game as a website. $run-on-server", skills)).toBe(
      "/run-on-server Make a 3d game as a website.",
    );
    expect(dispatchAcpSkillMention("Make a 3d game as a website. /run-on-server", skills)).toBe(
      "/run-on-server Make a 3d game as a website.",
    );
    expect(dispatchAcpSkillMention("Use $nova then $run-on-server to ship it", skills)).toBe(
      "/nova Use then /run-on-server to ship it",
    );
    expect(dispatchAcpSkillMention("$nova", skills)).toBe("/nova");
  });

  it("leaves unknown names, paths, prices and native commands alone", () => {
    for (const prompt of ["echo $HOME", "check /usr/bin", "costs $20k", "/review $nova now"])
      expect(dispatchAcpSkillMention(prompt, skills)).toBe(prompt);
    expect(dispatchAcpSkillMention("ship $nova", new Set())).toBe("ship $nova");
    expect(dispatchAcpSkillMention("keep\n    indented code\n$nova", skills)).toBe(
      "/nova keep\n    indented code",
    );
  });
});

describe("acpAdvertisedSkillNames", () => {
  it("reads Qwen Code's skill list and ignores anything else", () => {
    expect([...acpAdvertisedSkillNames({ availableSkills: ["nova", 3, ""] })]).toEqual(["nova"]);
    expect(acpAdvertisedSkillNames(null).size).toBe(0);
    expect(acpAdvertisedSkillNames({ availableSkills: "nova" }).size).toBe(0);
  });
});
