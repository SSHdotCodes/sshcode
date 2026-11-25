import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderSkill } from "@t3tools/contracts";

import { searchProviderSkills } from "./providerSkillSearch";

const skill = (name: string, description = ""): ServerProviderSkill => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  enabled: true,
  ...(description ? { description } : {}),
});

describe("searchProviderSkills recent use", () => {
  const skills = [
    skill("alpha-plan", "Plan alpha"),
    skill("browser", "Control browser"),
    skill("alpha-deploy", "Deploy alpha"),
  ];

  it("puts recently used skills first for an empty query", () => {
    expect(
      searchProviderSkills(skills, "", Number.POSITIVE_INFINITY, ["skill:alpha-deploy"]).map(
        (entry) => entry.name,
      ),
    ).toEqual(["alpha-deploy", "alpha-plan", "browser"]);
  });

  it("breaks equal-score query ties by recent use", () => {
    expect(
      searchProviderSkills(skills, "alpha", Number.POSITIVE_INFINITY, ["skill:alpha-deploy"]).map(
        (entry) => entry.name,
      ),
    ).toEqual(["alpha-deploy", "alpha-plan"]);
  });
});
