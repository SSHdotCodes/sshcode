import type { ServerProvider } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { providerDataUse, trainingNotice } from "./providerDataUse.ts";

const provider = (input: {
  readonly trainsOnContent?: boolean;
  readonly contributorOption?: boolean;
}): ServerProvider =>
  ({
    instanceId: "muse",
    displayName: "Muse Code",
    ...(input.trainsOnContent ? { trainsOnContent: true } : {}),
    models: [
      {
        slug: "wonder",
        name: "Wonder",
        isCustom: false,
        capabilities: {
          optionDescriptors: input.contributorOption
            ? [
                {
                  id: "contributorMode",
                  label: "Contributor mode",
                  type: "boolean",
                  currentValue: false,
                  trainsOnContent: true,
                },
              ]
            : [],
        },
      },
    ],
  }) as unknown as ServerProvider;

const selection = (options?: Record<string, boolean>) =>
  ({
    instanceId: "muse",
    model: "wonder",
    ...(options ? { options: Object.entries(options).map(([id, value]) => ({ id, value })) } : {}),
  }) as never;

it("says nothing about a provider that does not train on what it is sent", () => {
  expect(providerDataUse(provider({}))).toBeUndefined();
  expect(trainingNotice(provider({}), selection())).toBeUndefined();
});

it("names a provider marked as training in the catalog and when a subagent starts on it", () => {
  const marked = provider({ trainsOnContent: true });
  expect(providerDataUse(marked)).toBe("trains on what it is sent");
  expect(trainingNotice(marked, selection())).toBe(
    "Muse Code trains on what this subagent is sent.",
  );
});

it("names the option that switches training on, and warns only when it is on", () => {
  const optional = provider({ contributorOption: true });
  expect(providerDataUse(optional)).toBe(
    "trains on what it is sent when option contributorMode is on",
  );
  expect(trainingNotice(optional, selection())).toBeUndefined();
  expect(trainingNotice(optional, selection({ contributorMode: false }))).toBeUndefined();
  expect(trainingNotice(optional, selection({ contributorMode: true }))).toBe(
    "Muse Code trains on what this subagent is sent (option contributorMode is on).",
  );
});
