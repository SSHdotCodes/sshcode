import { createFileRoute } from "@tanstack/react-router";
import { ModelRankingsSettings } from "../components/settings/ModelRankingsSettings";
export const Route = createFileRoute("/settings/model-rankings")({
  component: ModelRankingsSettings,
});
