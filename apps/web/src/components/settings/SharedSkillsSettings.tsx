import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SharedSkill, SharedSkillsCommand } from "@t3tools/contracts";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useSharedSkillsCatalog } from "../../state/useSharedSkills";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ListState } from "../ui/list-state";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function commandError(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause.message : "Could not update skills.";
}

export function SharedSkillsSettings(props: {
  readonly environmentId: EnvironmentId | null;
  readonly environmentLabel: string | null;
  readonly showMachineNote: boolean;
}) {
  const catalog = useSharedSkillsCatalog(props.environmentId);
  const run = useAtomCommand(serverEnvironment.sharedSkillsCommand, { reportFailure: false });
  const [folderPath, setFolderPath] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const command = async (input: SharedSkillsCommand): Promise<boolean> => {
    if (props.environmentId === null || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await run({ environmentId: props.environmentId, input });
      const message = commandError(result);
      if (message) {
        setError(message);
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  };

  const addFolder = async () => {
    if (props.environmentId === null) return;
    let folder = folderPath.trim();
    if (isElectron) {
      const picked = await ensureLocalApi().dialogs.pickFolder();
      if (!picked) return;
      folder = picked;
    }
    if (folder.length === 0) return;
    if (await command({ type: "addFolder", path: folder })) setFolderPath("");
  };

  const remove = async (skill: SharedSkill) => {
    const confirmed = await requestConfirmDialog(`Remove ${skill.name} from the shared library?`, {
      variant: "destructive",
    });
    if (!confirmed) return;
    await command({ type: "remove", name: skill.name });
  };

  return (
    <SettingsSection id="skills" title="Skills">
      <SettingsRow
        title="Shared library"
        description={
          props.showMachineNote
            ? `Skills are stored on each machine. This list is from ${props.environmentLabel ?? "the first selected machine"}.`
            : "Installed once, then shared with the agents SSHCode runs."
        }
      />
      {props.environmentId === null ? (
        <ListState
          size="compact"
          title="No machine connected"
          description="Connect a machine to manage skills."
        />
      ) : catalog === null ? (
        <ListState
          loading
          size="compact"
          title="Loading skills"
          description="Reading the shared library."
        />
      ) : catalog.skills.length === 0 ? (
        <ListState
          size="compact"
          title="No skills yet"
          description="Add a folder that contains SKILL.md, or a Git URL."
        />
      ) : (
        catalog.skills.map((skill) => (
          <SettingsRow
            key={skill.directoryName}
            title={skill.name}
            // What the skill does, cut to two lines; where it comes from and who gets it
            // sit on their own quieter line instead of running on from the description.
            description={
              skill.description ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="line-clamp-2" />}>
                    {skill.description}
                  </TooltipTrigger>
                  <TooltipPopup>{skill.description}</TooltipPopup>
                </Tooltip>
              ) : undefined
            }
            status={
              [skill.origin, skill.harnesses]
                .filter((part) => part && part.length > 0)
                .join(" · ") || undefined
            }
            control={
              <Switch
                checked={skill.enabled}
                disabled={busy}
                onCheckedChange={(checked) =>
                  void command({ type: "setSharing", name: skill.name, enabled: Boolean(checked) })
                }
                aria-label={`Share ${skill.name}`}
              />
            }
          >
            {skill.canUpdate || skill.canRemove ? (
              <div className="flex gap-2 pb-2">
                {skill.canUpdate ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void command({ type: "update", name: skill.name })}
                  >
                    Update
                  </Button>
                ) : null}
                {skill.canRemove ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void remove(skill)}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            ) : null}
          </SettingsRow>
        ))
      )}
      {props.environmentId === null ? null : (
        <SettingsRow
          title="Add a skill"
          description="A local folder is copied in. A Git URL is cloned."
        >
          <div className="mt-2.5 flex flex-col gap-2 pb-1">
            {isElectron ? (
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={busy}
                onClick={() => void addFolder()}
              >
                Add from a folder
              </Button>
            ) : (
              <div className="flex gap-2">
                <Input
                  size="sm"
                  value={folderPath}
                  placeholder="Folder path"
                  aria-label="Skill folder path"
                  onChange={(event) => setFolderPath(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="w-28 shrink-0"
                  disabled={busy}
                  onClick={() => void addFolder()}
                >
                  Add folder
                </Button>
              </div>
            )}
            <div className="flex gap-2">
              <Input
                size="sm"
                value={gitUrl}
                placeholder="https:// or git@"
                aria-label="Git URL"
                onChange={(event) => setGitUrl(event.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                className="w-28 shrink-0"
                disabled={busy || gitUrl.trim().length === 0}
                onClick={() => {
                  const url = gitUrl.trim();
                  if (url.length === 0) return;
                  void command({ type: "addGit", url }).then((added) => {
                    if (added) setGitUrl("");
                  });
                }}
              >
                Add Git URL
              </Button>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}
