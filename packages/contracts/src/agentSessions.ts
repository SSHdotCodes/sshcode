import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Coding agent home directories the scanner knows how to read. */
export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

export const TerminalHandoffInput = Schema.Struct({ threadId: ThreadId });
export const TerminalHandoffStatus = Schema.Struct({
  phase: Schema.Literals(["here", "handing-off", "in-terminal"]),
  startedAt: Schema.NullOr(Schema.String),
  unavailableReason: Schema.NullOr(Schema.String),
});
export type TerminalHandoffStatus = typeof TerminalHandoffStatus.Type;
export class TerminalHandoffError extends Schema.TaggedError<TerminalHandoffError>()(
  "TerminalHandoffError",
  { message: Schema.String },
) {}

/** File identity saved with an imported session so bounded retries can skip unchanged history. */
export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  inode: Schema.NullOr(Schema.Number),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

/**
 * Empty for now. Kept as a struct so future scan options (source filters,
 * explicit roots) can be added without a new method.
 */
export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

/**
 * A directory that at least one agent CLI has run in, suitable for import as a
 * SSHCode project. `alreadyImported` marks candidates that already have an
 * active project rooted at the same path.
 */
/**
 * Git identity of a candidate directory, read from `.git/config` without
 * spawning git. `remoteKey` is the normalized origin URL, shared by every
 * clone of the same repository so the client can group them. `repository`
 * is the GitHub `owner/name` when the origin is on GitHub.
 */
export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  /**
   * `null` when the directory is not the root of a git repository. Missing on
   * servers that predate the git scan, where the client cannot tell repositories
   * from plain folders and should treat every candidate as a standalone project.
   */
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}

const NativeSessionHandle = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/** Opaque, short-lived selection handles never accept a client-supplied filesystem path. */
export const NativeSession = Schema.Struct({
  sessionKey: NativeSessionHandle,
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  nativeId: TrimmedNonEmptyString,
  title: Schema.String,
  cwd: TrimmedNonEmptyString,
  host: Schema.String,
  lastActiveAt: IsoDateTime,
  importedThreadId: Schema.NullOr(ThreadId),
  mayBeActive: Schema.Boolean,
});
export type NativeSession = typeof NativeSession.Type;
export const NativeSessionDiscoverInput = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  cursor: Schema.optional(NativeSessionHandle),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 50 })),
  ),
});
export type NativeSessionDiscoverInput = typeof NativeSessionDiscoverInput.Type;
export const NativeSessionDiscoverResult = Schema.Struct({
  sessions: Schema.Array(NativeSession),
  nextCursor: Schema.NullOr(Schema.String),
  scanning: Schema.Boolean,
});
export type NativeSessionDiscoverResult = typeof NativeSessionDiscoverResult.Type;
export const NativeSessionSelectionInput = Schema.Struct({ sessionKey: NativeSessionHandle });
export const NativeSessionPreviewResult = Schema.Struct({
  session: NativeSession,
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      createdAt: IsoDateTime,
    }),
  ),
  truncated: Schema.Boolean,
});
export type NativeSessionPreviewResult = typeof NativeSessionPreviewResult.Type;
export const NativeSessionOpenInput = Schema.Struct({
  ...NativeSessionSelectionInput.fields,
  confirmActive: Schema.optional(Schema.Boolean),
});
export type NativeSessionOpenInput = typeof NativeSessionOpenInput.Type;
export const NativeSessionOpenResult = Schema.Struct({
  threadId: ThreadId,
  reused: Schema.Boolean,
});
export class NativeSessionError extends Schema.TaggedError<NativeSessionError>()(
  "NativeSessionError",
  {
    reason: Schema.Literals(["expired", "changed", "unreadable", "active", "import-failed"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "expired":
        return "This session list expired. Search again to refresh it.";
      case "changed":
        return "This session changed. Refresh the list before continuing.";
      case "active":
        return "This session may be active in a terminal. Stop it there before continuing.";
      case "unreadable":
        return "This session could not be read. Refresh the list and try again.";
      case "import-failed":
        return "This session could not be opened. Check that its folder still exists and try again.";
    }
  }
}
