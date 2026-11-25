import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { privacyLabel } from "@t3tools/client-runtime/privacy";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { GitBranchIcon } from "lucide-react";

import { usePrivacyMode } from "~/hooks/usePrivacyMode";
import { useProject } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { ProjectFavicon } from "./ProjectFavicon";
import {
  ThreadHoverCard,
  ThreadHoverCardLastMessage,
  ThreadHoverCardPopup,
} from "./ThreadHoverCard";
import { ThreadPullRequestsMiniList } from "./ThreadStatusIndicators";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import { threadMessagePreview } from "./threadMessagePreview";
import { MiddleTruncate } from "./ui/middle-truncate";
import { TooltipPopup } from "./ui/tooltip";

type ThreadChipShell = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "projectId" | "branch" | "runtime" | "modelSelection" | "pullRequests"
> & {
  readonly source: { readonly latestVisibleMessage: Parameters<typeof threadMessagePreview>[0] };
};

export function ThreadChipPreview({
  shell,
  title,
}: {
  shell: ThreadChipShell | null;
  title: string;
}) {
  if (!shell) return <TooltipPopup side="top">Chat no longer available</TooltipPopup>;
  return (
    <ThreadHoverCardPopup side="top" className="w-64">
      <ThreadChipPreviewContent shell={shell} title={title} />
    </ThreadHoverCardPopup>
  );
}

function ThreadChipPreviewContent({ shell, title }: { shell: ThreadChipShell; title: string }) {
  const privacy = usePrivacyMode();
  if (privacy) {
    return (
      <ThreadHoverCard title={privacyLabel(true, "Chat", shell.id, title)}>
        <p>Details hidden while screen recording privacy is on.</p>
      </ThreadHoverCard>
    );
  }
  return <ThreadChipPreviewDetails shell={shell} title={title} />;
}

/** TooltipPopup mounts its content on demand. Read the shell and its environment's metadata. */
function ThreadChipPreviewDetails({ shell, title }: { shell: ThreadChipShell; title: string }) {
  const project = useProject(scopeProjectRef(shell.environmentId, shell.projectId));
  const providers = useAtomValue(serverEnvironment.providersValueAtom(shell.environmentId));
  const instanceId = shell.runtime?.providerInstanceId ?? shell.modelSelection.instanceId;
  const provider = providers?.find((entry) => entry.instanceId === instanceId);
  const selectedModel = provider?.models.find((model) => model.slug === shell.modelSelection.model);
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : shell.modelSelection.model;
  return (
    <ThreadHoverCard
      title={title}
      footer={
        <>
          <ThreadHoverCardLastMessage
            preview={threadMessagePreview(shell.source.latestVisibleMessage)}
          />
          {shell.pullRequests.length > 0 ? (
            <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
              <ThreadPullRequestsMiniList pullRequests={shell.pullRequests} />
            </div>
          ) : null}
        </>
      }
    >
      {project ? (
        <div className="flex min-w-0 items-center gap-2">
          <ProjectFavicon project={project} className="size-3 shrink-0" />
          <div className="min-w-0 truncate text-foreground/75">{project.title}</div>
        </div>
      ) : null}
      {shell.branch ? (
        <div className="flex min-w-0 items-center gap-2">
          <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
          <MiddleTruncate value={shell.branch} className="flex" />
        </div>
      ) : null}
      {modelLabel ? (
        <div className="flex min-w-0 items-center gap-2">
          {provider ? (
            <ProviderInstanceIcon
              driverKind={provider.driver}
              displayName={resolveProviderInstanceDisplayName(provider)}
              acpRegistryIconUrl={provider.iconUrl}
              iconClassName="size-3 shrink-0 grayscale opacity-60"
            />
          ) : null}
          <div className="min-w-0 truncate text-foreground/75">{modelLabel}</div>
        </div>
      ) : null}
    </ThreadHoverCard>
  );
}
