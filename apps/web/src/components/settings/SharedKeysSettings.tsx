import type { EnvironmentId, ServerSettings, SharedKeyId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { SecretInput } from "./SecretInput";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** A stable key id from its label, unique among the existing ones. */
export function sharedKeyIdForLabel(label: string, existing: Iterable<string>): SharedKeyId {
  const taken = new Set(existing);
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "key";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id as SharedKeyId;
}

/** Display names of the provider instances whose variables link each key. */
export function sharedKeyUsers(
  providerInstances: ServerSettings["providerInstances"],
): ReadonlyMap<string, ReadonlyArray<string>> {
  const users = new Map<string, string[]>();
  for (const [instanceId, instance] of Object.entries(providerInstances)) {
    const name = instance.displayName ?? instanceId;
    for (const variable of instance.environment ?? []) {
      if (variable.sharedKey === undefined) continue;
      const list = users.get(variable.sharedKey) ?? [];
      if (!list.includes(name)) list.push(name);
      users.set(variable.sharedKey, list);
    }
  }
  return users;
}

/**
 * API keys pasted once per environment. A provider's variable links one
 * instead of holding its own copy, under whatever name that harness reads.
 */
export function SharedKeysSettings({
  environmentId,
  sharedKeys,
  providerInstances,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly sharedKeys: ServerSettings["sharedKeys"];
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [adding, setAdding] = useState(false);
  const entries = Object.entries(sharedKeys).toSorted(([, a], [, b]) =>
    a.label.localeCompare(b.label),
  );
  const users = sharedKeyUsers(providerInstances);
  // The stored value round-trips as redacted; only a typed value replaces it.
  const keep = (id: string) => {
    const key = sharedKeys[id as SharedKeyId];
    return key?.valueRedacted === true
      ? { value: "", valueRedacted: true }
      : { value: key?.value ?? "" };
  };

  return (
    <SettingsSection
      {...searchableSetting("shared-keys")}
      headerAction={
        !readOnly ? (
          <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
            <PlusIcon className="size-3" aria-hidden />
            Add key
          </Button>
        ) : null
      }
    >
      {entries.length === 0 && !adding ? (
        <SettingsRow
          title="No shared keys"
          description="Add an API key once, then pick it in any provider's variables instead of pasting it again."
        />
      ) : null}
      {entries.map(([id, key]) => {
        const usedBy = users.get(id) ?? [];
        return (
          <SettingsRow
            key={id}
            title={
              readOnly ? (
                key.label
              ) : (
                <DraftInput
                  size="sm"
                  className="w-44"
                  value={key.label}
                  aria-label={`Name of shared key ${key.label}`}
                  onCommit={(label) => {
                    const next = label.trim();
                    if (next.length === 0 || next === key.label) return;
                    updateSettings({ sharedKeys: { [id]: { label: next, ...keep(id) } } });
                  }}
                />
              )
            }
            description={usedBy.length > 0 ? `Used by ${usedBy.join(", ")}` : "Not used yet"}
            control={
              <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-72">
                <SecretInput
                  size="sm"
                  className="min-w-0 flex-1"
                  value={key.valueRedacted ? "" : key.value}
                  configured={key.valueRedacted === true}
                  placeholder="Paste the key"
                  aria-label={`Value of shared key ${key.label}`}
                  disabled={readOnly}
                  onCommit={(value) =>
                    updateSettings({ sharedKeys: { [id]: { label: key.label, value } } })
                  }
                />
                {!readOnly ? (
                  <RemoveSharedKeyButton
                    label={key.label}
                    usedBy={usedBy}
                    onConfirm={() => updateSettings({ sharedKeys: { [id]: null } })}
                  />
                ) : null}
              </div>
            }
          />
        );
      })}
      {adding && !readOnly ? (
        <SettingsRow
          title={
            <DraftInput
              size="sm"
              className="w-44"
              autoFocus
              value=""
              placeholder="Name, e.g. OpenRouter"
              aria-label="Name of the new shared key"
              onCommit={(label) => {
                const name = label.trim();
                setAdding(false);
                if (name.length === 0) return;
                const id = sharedKeyIdForLabel(name, Object.keys(sharedKeys));
                updateSettings({ sharedKeys: { [id]: { label: name, value: "" } } });
              }}
            />
          }
          description="Name it, then paste the key."
        />
      ) : null}
    </SettingsSection>
  );
}

/** Deleting a key empties every variable that links it, so it asks first. */
function RemoveSharedKeyButton({
  label,
  usedBy,
  onConfirm,
}: {
  readonly label: string;
  readonly usedBy: ReadonlyArray<string>;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {usedBy.length > 0
                ? `The key is deleted from this server, and ${usedBy.join(", ")} lose it until you link another key or paste one.`
                : "The key is deleted from this server."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Remove key
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
