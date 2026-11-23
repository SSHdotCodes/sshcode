export interface EnvironmentLabelInput {
  readonly id: string;
  readonly label: string;
  readonly address?: string | null | undefined;
  readonly host?: string | null | undefined;
}

function hostname(environment: EnvironmentLabelInput): string {
  const address = (environment.address || environment.host || "").trim();
  if (!address) return "";
  // Parse only the authority: this also works with Hermes' minimal URL implementation.
  const authority = address.replace(/^[a-z][a-z\d+.-]*:\/\//iu, "").split(/[/?#]/u)[0]!;
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  if (host.startsWith("["))
    return host.slice(1, host.indexOf("]") > 0 ? host.indexOf("]") : undefined).toLowerCase();
  return (host.split(":").length > 2 ? host : host.replace(/:\d*$/u, "")).toLowerCase();
}

/** Display-only names; never persist these suffixes back into connection settings. */
export function environmentLabels(
  environments: ReadonlyArray<EnvironmentLabelInput>,
): ReadonlyMap<string, string> {
  const groups = new Map<string, EnvironmentLabelInput[]>();
  for (const environment of environments) {
    const group = groups.get(environment.label) ?? [];
    group.push(environment);
    groups.set(environment.label, group);
  }
  const labels = new Map<string, string>();
  for (const [name, group] of groups) {
    if (group.length === 1) {
      labels.set(group[0]!.id, name);
      continue;
    }
    const hosts = group.map(hostname);
    if (hosts.every(Boolean) && new Set(hosts).size === group.length) {
      group.forEach((environment, index) =>
        labels.set(environment.id, `${name} · ${hosts[index]}`),
      );
      continue;
    }
    // A host collision (including an unknown host) needs stable ordinal names.
    const ordered = [...group].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    ordered.forEach((environment, index) =>
      labels.set(environment.id, index === 0 ? name : `${name} ${index + 1}`),
    );
  }
  return labels;
}
