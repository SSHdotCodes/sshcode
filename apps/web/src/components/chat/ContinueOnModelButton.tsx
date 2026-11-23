import { ChevronDownIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import type { ContinueCandidate } from "./continueOnModel";

/** "Continue on <model>" for a chat whose model stopped at the provider, with other choices. */
export function ContinueOnModelButton(props: {
  readonly candidates: ReadonlyArray<ContinueCandidate>;
  readonly busy: boolean;
  readonly onContinue: (candidate: ContinueCandidate) => void;
}) {
  const [first, ...others] = props.candidates;
  if (first === undefined) return null;
  return (
    <span className="continue-on-model inline-flex items-center gap-1">
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={props.busy}
        onClick={() => props.onContinue(first)}
      >
        {props.busy ? "Continuing…" : `Continue on ${first.label}`}
      </Button>
      {others.length > 0 ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="outline"
                disabled={props.busy}
                aria-label="Continue on another model"
              />
            }
          >
            <ChevronDownIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="start">
            {others.map((candidate) => (
              <MenuItem
                key={`${candidate.instanceId}:${candidate.model}`}
                onClick={() => props.onContinue(candidate)}
              >
                {candidate.label}
                {candidate.label === candidate.providerLabel ? null : (
                  <span className="ms-auto ps-3 text-xs text-muted-foreground">
                    {candidate.providerLabel}
                  </span>
                )}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </span>
  );
}
