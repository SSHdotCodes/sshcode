import { RegistryContext, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { confirmedDesktopSignIn } from "../../environments/primary";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The Mac app opens before its server is up and its connection backs off
 * meanwhile. Once the server has answered, connect now rather than at the
 * next backoff rung, which can be seconds away.
 */
export function DesktopEarlyLaunchReconnect() {
  const registry = useContext(RegistryContext);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const retryNow = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });

  useEffect(() => {
    const confirmation = confirmedDesktopSignIn();
    if (confirmation === null || primaryEnvironmentId === null) return;
    let cancelled = false;
    void confirmation.then(
      () => {
        if (cancelled) return;
        const state = AsyncResult.value(
          registry.get(environmentCatalog.stateAtom(primaryEnvironmentId)),
        );
        // Only a waiting connection: a retry would cut short one already connecting.
        if (Option.isSome(state) && state.value.phase === "backoff") {
          void retryNow(primaryEnvironmentId);
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [primaryEnvironmentId, registry, retryNow]);

  return null;
}
