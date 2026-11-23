import { createFileRoute } from "@tanstack/react-router";

import { ChatsSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/chats")({
  component: ChatsSettingsPanel,
});
