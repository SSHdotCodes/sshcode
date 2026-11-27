/**
 * `--instructions <file>`: test a candidate wording of the lead's orchestration section without
 * editing the source. Every prompt the eval builds swaps the current section for the file's text.
 */
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

let candidate: string | null = null;

/** The section the source would send; a candidate file holds a full replacement for it. */
export const currentOrchestrationSection = () => T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim();

export function setInstructionsOverride(text: string | null): void {
  candidate = text === null ? null : text.trim();
}

/** Swaps the section where a prompt piece contains it; other pieces pass through. */
export function withInstructionsOverride(text: string): string {
  if (candidate === null) return text;
  const current = currentOrchestrationSection();
  return text.includes(current) ? text.replace(current, () => candidate!) : text;
}

/** Fails loudly when a candidate is set but none of a prompt's pieces carried the section. */
export function requireInstructionsApplied(pieces: ReadonlyArray<string>): void {
  if (candidate === null) return;
  if (!pieces.some((piece) => piece.includes(candidate!)))
    throw new Error("--instructions: the prompt no longer contains the orchestration section.");
}
