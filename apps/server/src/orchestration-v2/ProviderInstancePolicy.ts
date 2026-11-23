import {
  type CommandId,
  ProjectId,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Only the command admitted through thread management checks its resolved run target.
 * A delegated request's first child message shares the parent command id.
 */
export const ProjectAdmissionCommandId = Context.Reference<CommandId | undefined>(
  "t3/orchestration-v2/ProjectAdmissionCommandId",
  { defaultValue: () => undefined },
);

export class ThreadManagementProviderInstanceDisabledError extends Schema.TaggedError<ThreadManagementProviderInstanceDisabledError>()(
  "ThreadManagementProviderInstanceDisabledError",
  { projectId: ProjectId, instanceId: ProviderInstanceId },
) {
  override get message(): string {
    return `Provider instance "${this.instanceId}" is disabled for project ${this.projectId}.`;
  }
}

/** The shared admission rule for messages, including answers dispatched inside a command. */
export const assertProviderInstanceEnabled = (
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
  input: { readonly projectId: ProjectId; readonly instanceId: ProviderInstanceId },
) =>
  resolveProjectProviderInstanceEnabled(settings, input.projectId, input.instanceId)
    ? Effect.void
    : Effect.fail(new ThreadManagementProviderInstanceDisabledError(input));
