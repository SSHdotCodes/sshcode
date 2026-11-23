import { HarnessMascot } from "../HarnessMascot";
import { MascotCompanion } from "../MascotCompanion";
import type { DraftId } from "~/composerDraftStore";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { InlineButton } from "../ui/button";

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

/**
 * New chats in this fork have no project or folder: like Claude Code and
 * Codex used outside a repo, the agent works across the whole machine, so the
 * headline offers no workspace picker.
 */
export function DraftHeroHeadline({
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const { scratchEnvironmentId, scratchWorkspaceRootFor } = useScratchProject();
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(
    scratchEnvironmentId(activeProjectRef?.environmentId ?? primaryEnvironmentId),
  );

  // A server without a home for project-less chats needs a project to start in.
  const needsProject =
    scratchWorkspaceRoot === null && activeProjectTitle === null && projects.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <MascotCompanion state="greet" size={96}>
        {(state) => <HarnessMascot state={state} size={96} />}
      </MascotCompanion>
      <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        {needsProject ? "Add a project to start" : "What should we work on?"}
      </h1>
      {needsProject ? (
        <p className="mt-2 flex h-6 items-center text-sm">
          <InlineButton tone="muted" className="pointer-events-auto" onClick={openAddProject}>
            Add project
          </InlineButton>
        </p>
      ) : null}
    </div>
  );
}
