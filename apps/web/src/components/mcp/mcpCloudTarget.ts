import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { CloudLinkTarget } from "~/cloud/linkEnvironment";

/** A direct route identifies the host's own port; an SSH forward does not. */
export function mcpCloudTarget(prepared: PreparedConnection | null): CloudLinkTarget | null {
  if (prepared === null) return null;
  const primary = prepared.target._tag === "PrimaryConnectionTarget";
  if (
    !primary &&
    (prepared.target._tag !== "BearerConnectionTarget" ||
      prepared.httpAuthorization?._tag !== "Bearer")
  )
    return null;
  const ws = new URL(prepared.httpBaseUrl);
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  ws.pathname = "/ws";
  ws.search = "";
  ws.hash = "";
  return {
    environmentId: prepared.environmentId,
    label: prepared.label,
    httpBaseUrl: prepared.httpBaseUrl,
    wsBaseUrl: ws.toString(),
    ...(!primary && prepared.httpAuthorization?._tag === "Bearer"
      ? { bearerToken: prepared.httpAuthorization.token }
      : {}),
  };
}
