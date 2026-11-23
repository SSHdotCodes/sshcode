import * as Schema from "effect/Schema";

import { getLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";

function storageKey(environmentId: string, absolutePath: string) {
  return `t3code:workspace-html-scripts:${JSON.stringify([environmentId, absolutePath])}`;
}

export function readWorkspaceHtmlScripts(environmentId: string, absolutePath: string) {
  try {
    return getLocalStorageItem(storageKey(environmentId, absolutePath), Schema.Boolean) === true;
  } catch {
    return false;
  }
}

export function useWorkspaceHtmlScripts(environmentId: string, absolutePath: string) {
  return useLocalStorage(storageKey(environmentId, absolutePath), false, Schema.Boolean);
}

export function WorkspaceHtmlScriptsBar(props: {
  readonly allowed: boolean;
  readonly onChange: (allowed: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
      <span>
        {props.allowed ? "Scripts are on for this file" : "Scripts are off for this file"}
      </span>
      <button type="button" className="underline" onClick={() => props.onChange(!props.allowed)}>
        {props.allowed ? "Turn scripts off" : "Run"}
      </button>
    </div>
  );
}
