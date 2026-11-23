import { AuthSettingsWriteScope, type AuthEnvironmentScope } from "@t3tools/contracts";

/** Owner clients have settings access. Guest shares and agent tokens never train owner preferences. */
export function canRecordAutoModelFeedback(session: {
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}): boolean {
  return (
    session.scopes.includes(AuthSettingsWriteScope) &&
    !/^(?:guest:|share:|outside-agent:|mcp-client(?:$|:))/.test(session.subject)
  );
}

/** Preserve append order across restarts and keep the log strictly bounded. */
export function appendAutoModelRecord(
  contents: string,
  record: string,
): { rewrite: boolean; contents: string } {
  const lines = contents.split("\n").filter((line) => line.trim().length > 0);
  const rewrite = lines.length >= 2000;
  return {
    rewrite,
    contents: rewrite ? [...lines.slice(-1999), record].join("\n") + "\n" : record + "\n",
  };
}
