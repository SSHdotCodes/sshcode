import {
  BOTS_NOTE,
  BOTS_TITLE,
  NEW_BOT_LABEL,
  botsEnabledPatch,
  serverSupportsBots,
} from "@t3tools/client-runtime/state/bots";
import {
  botsSettings,
  type Bot,
  type EnvironmentId,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { PencilIcon, PlusIcon } from "lucide-react";

import { BotAvatar } from "../bots/BotAvatar";
import { openBotSheet } from "../bots/botRequests";
import {
  useBotPresence,
  useBotsRuntime,
  useCanEditBots,
  useEnvironmentBots,
} from "../bots/useBots";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const selectBotsEnabled = (settings: UnifiedSettings) => botsSettings(settings).enabled;

/** Settings > Bots: the switch, and while it is on, this server's bots. */
export function BotsSettings() {
  const { environment } = useSettingsScope();
  const enabled = useScopedSettings(selectBotsEnabled);
  const updateSettings = useUpdateScopedSettings();
  const canWrite = useScopedSettingsWriteAllowed();
  if (!environment?.serverConfig) {
    return <SettingsPageContainer>Connect an environment to set up bots.</SettingsPageContainer>;
  }
  if (!serverSupportsBots(environment.serverConfig)) {
    return <SettingsPageContainer>Update this server to use bots.</SettingsPageContainer>;
  }
  return (
    <SettingsPageContainer>
      <SettingsSection title={BOTS_TITLE} hideTitle id="bots">
        <SettingsRow
          serverScoped
          settingKeys={["bots"]}
          {...searchableSetting("bots")}
          description={BOTS_NOTE}
          control={
            <Switch
              checked={enabled}
              disabled={!canWrite}
              aria-label={BOTS_TITLE}
              onCheckedChange={(checked) => updateSettings(botsEnabledPatch(Boolean(checked)))}
            />
          }
        />
      </SettingsSection>
      {enabled ? <BotList environmentId={environment.environmentId} /> : null}
    </SettingsPageContainer>
  );
}

function BotList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const view = useEnvironmentBots(environmentId);
  const runtime = useBotsRuntime(environmentId, view.active);
  const canEdit = useCanEditBots(environmentId);
  const newBot = (
    <Button
      size="xs"
      variant="outline"
      disabled={!canEdit}
      onClick={() => openBotSheet(environmentId)}
    >
      <PlusIcon />
      {NEW_BOT_LABEL}
    </Button>
  );
  return (
    <SettingsSection
      title="Your bots"
      id="bots-list"
      headerAction={view.list.length > 0 ? newBot : null}
    >
      {view.list.length === 0 ? (
        <div className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4">
          <p className="text-sm text-muted-foreground">No bots yet.</p>
          {newBot}
        </div>
      ) : (
        view.list.map((bot) => (
          <BotListRow
            key={bot.id}
            environmentId={environmentId}
            bot={bot}
            runtime={runtime.byBotId.get(bot.id)}
            canEdit={canEdit}
          />
        ))
      )}
    </SettingsSection>
  );
}

function BotListRow(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly runtime: Parameters<typeof useBotPresence>[2];
  readonly canEdit: boolean;
}) {
  const { bot } = props;
  const presence = useBotPresence(props.environmentId, bot, props.runtime);
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
      <BotAvatar
        color={bot.color}
        size={32}
        state={presence.avatarState}
        ringClassName="stroke-card"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{bot.name}</p>
        <p
          className={
            presence.status.kind === "needsYou"
              ? "truncate text-xs text-warning"
              : "truncate text-xs text-muted-foreground"
          }
        >
          {presence.status.label}
        </p>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Edit ${bot.name}`}
              disabled={!props.canEdit}
              onClick={() => openBotSheet(props.environmentId, bot.id)}
            />
          }
        >
          <PencilIcon />
        </TooltipTrigger>
        <TooltipPopup>Edit</TooltipPopup>
      </Tooltip>
    </div>
  );
}
