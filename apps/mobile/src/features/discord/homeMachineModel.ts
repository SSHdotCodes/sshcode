export {
  homeMachineSummaries,
  threadNeedsYou,
  threadHasUnreadOutput,
} from "../../lib/thread-summaries";

export function visibleHomeMachine(
  selected: string | null,
  machines: ReadonlyMap<string, unknown>,
) {
  return selected !== null && machines.has(selected) ? selected : null;
}
