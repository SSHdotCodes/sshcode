import {
  BOT_COLOR_KEYS,
  BOT_PERMISSION_ROWS,
  BOT_PERSONALITY_PLACEHOLDER,
  CREATE_BOT_LABEL,
  NEW_BOT_LABEL,
  botPalette,
  cleanBotName,
  nextBotColor,
  nextBotName,
} from "@t3tools/client-runtime/state/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  BOT_NAME_MAX,
  BOT_PERSONALITY_MAX,
  DEFAULT_BOT_PERMISSIONS,
  botColor,
  type Bot,
  type BotPermissions,
  type EnvironmentId,
  type ModelSelection,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { BotAvatar } from "./BotAvatar";
import { BotModelPicker, latestChatModel } from "./BotModelPicker";
import { closeBotSheet, useBotSheetRequest } from "./botRequests";
import { environmentBotsAtom, useBotCommand } from "./useBots";
import { appAtomRegistry } from "../../rpc/atomRegistry";

export function BotSheetHost() {
  const request = useBotSheetRequest((state) => state.request);
  if (request === null) return null;
  const bot =
    request.botId === null
      ? null
      : (appAtomRegistry
          .get(environmentBotsAtom(request.environmentId))
          .list.find((candidate) => candidate.id === request.botId) ?? null);
  if (request.botId !== null && bot === null) return null;
  return (
    <BotSheet
      key={`${request.environmentId}:${request.botId ?? "new"}`}
      environmentId={request.environmentId}
      bot={bot}
    />
  );
}

interface Draft {
  readonly name: string;
  readonly color: string;
  readonly target: ModelSelection | null;
  readonly personality: string;
  readonly permissions: BotPermissions;
}

function initialDraft(environmentId: EnvironmentId, bot: Bot | null): Draft {
  if (bot !== null) {
    return {
      name: bot.name,
      color: botColor(bot.color),
      target: bot.target,
      personality: bot.personality ?? "",
      permissions: bot.permissions,
    };
  }
  const list = appAtomRegistry.get(environmentBotsAtom(environmentId)).list;
  return {
    name: nextBotName(list),
    color: nextBotColor(list),
    target: latestChatModel(environmentId),
    personality: "",
    permissions: DEFAULT_BOT_PERMISSIONS,
  };
}

function BotSheet({ environmentId, bot }: { environmentId: EnvironmentId; bot: Bot | null }) {
  const id = useId();
  const router = useRouter();
  const runBotCommand = useBotCommand();
  const [draft, setDraft] = useState(() => initialDraft(environmentId, bot));
  const [saving, setSaving] = useState(false);
  const name = cleanBotName(draft.name);
  const canSave = name.length > 0 && draft.target !== null && !saving;
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const save = async () => {
    if (!canSave || draft.target === null) return;
    setSaving(true);
    const personality = draft.personality.trim();
    if (bot === null) {
      const created = await runBotCommand(
        environmentId,
        {
          type: "create",
          name,
          color: draft.color,
          target: draft.target,
          ...(personality ? { personality } : {}),
          permissions: draft.permissions,
        },
        "Couldn't create the bot",
      );
      setSaving(false);
      if (!created.ok) return;
      closeBotSheet();
      const threadId = created.result.bot?.threadId;
      if (threadId) {
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
        });
      }
      return;
    }
    const updated = await runBotCommand(
      environmentId,
      {
        type: "update",
        botId: bot.id,
        ...(name !== bot.name ? { name } : {}),
        ...(draft.color !== botColor(bot.color) ? { color: draft.color } : {}),
        ...(draft.target.instanceId !== bot.target.instanceId ||
        draft.target.model !== bot.target.model ||
        draft.target.options !== bot.target.options
          ? { target: draft.target }
          : {}),
        ...(personality !== (bot.personality ?? "") ? { personality } : {}),
        permissions: draft.permissions,
      },
      "Couldn't save the bot",
    );
    setSaving(false);
    if (updated.ok) closeBotSheet();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : closeBotSheet())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{bot === null ? NEW_BOT_LABEL : `Edit ${bot.name}`}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col items-center gap-3">
            <BotAvatar color={draft.color} size={72} ringClassName="stroke-popover" />
            <div
              role="radiogroup"
              aria-label="Color"
              className="flex flex-wrap justify-center gap-1.5"
            >
              {BOT_COLOR_KEYS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={draft.color === color}
                  aria-label={color}
                  onClick={() => update({ color })}
                  className={cn(
                    "flex size-7 cursor-pointer items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    draft.color === color && "border-foreground/64",
                  )}
                >
                  <span
                    className="size-5 rounded-full"
                    style={{ backgroundColor: botPalette(color).fill }}
                  />
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              value={draft.name}
              maxLength={BOT_NAME_MAX}
              autoComplete="off"
              onChange={(event) => update({ name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Model</Label>
            <div>
              <BotModelPicker
                environmentId={environmentId}
                value={draft.target}
                disabled={saving}
                onChange={(target) => update({ target })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-personality`} className="flex items-baseline justify-between">
              <span>Personality</span>
              <span className="text-xs font-normal text-muted-foreground">Optional</span>
            </Label>
            <Textarea
              id={`${id}-personality`}
              value={draft.personality}
              maxLength={BOT_PERSONALITY_MAX}
              placeholder={BOT_PERSONALITY_PLACEHOLDER}
              rows={2}
              onChange={(event) => update({ personality: event.target.value })}
            />
          </div>
          <BotPermissionSwitches
            permissions={draft.permissions}
            disabled={saving}
            onChange={(permissions) => update({ permissions })}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={closeBotSheet}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {bot === null ? CREATE_BOT_LABEL : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The four permission rows, in plain words. Used by the sheet and the info panel. */
export function BotPermissionSwitches(props: {
  readonly permissions: BotPermissions;
  readonly disabled?: boolean;
  readonly onChange: (permissions: BotPermissions) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-3">
      {BOT_PERMISSION_ROWS.map((row) => (
        <div key={row.key} className="flex items-start justify-between gap-3">
          <label htmlFor={`${id}-${row.key}`} className="min-w-0 cursor-pointer">
            <span className="block text-sm font-medium text-foreground">{row.title}</span>
            <span className="block text-xs leading-normal text-muted-foreground">{row.copy}</span>
          </label>
          <Switch
            id={`${id}-${row.key}`}
            className="mt-0.5"
            checked={props.permissions[row.key]}
            disabled={props.disabled ?? false}
            onCheckedChange={(checked) =>
              props.onChange({ ...props.permissions, [row.key]: Boolean(checked) })
            }
          />
        </div>
      ))}
    </div>
  );
}
