import type { Icon } from "@tabler/icons-react-native/types";
import IconAppWindow from "@tabler/icons-react-native/IconAppWindow";
import IconAtom from "@tabler/icons-react-native/IconAtom";
import IconBook from "@tabler/icons-react-native/IconBook";
import IconBrain from "@tabler/icons-react-native/IconBrain";
import IconBug from "@tabler/icons-react-native/IconBug";
import IconBulb from "@tabler/icons-react-native/IconBulb";
import IconChartBar from "@tabler/icons-react-native/IconChartBar";
import IconCheck from "@tabler/icons-react-native/IconCheck";
import IconCircleX from "@tabler/icons-react-native/IconCircleX";
import IconCoins from "@tabler/icons-react-native/IconCoins";
import IconCompass from "@tabler/icons-react-native/IconCompass";
import IconCpu from "@tabler/icons-react-native/IconCpu";
import IconDeviceMobile from "@tabler/icons-react-native/IconDeviceMobile";
import IconEraser from "@tabler/icons-react-native/IconEraser";
import IconEye from "@tabler/icons-react-native/IconEye";
import IconFeather from "@tabler/icons-react-native/IconFeather";
import IconFlask from "@tabler/icons-react-native/IconFlask";
import IconGauge from "@tabler/icons-react-native/IconGauge";
import IconGitBranch from "@tabler/icons-react-native/IconGitBranch";
import IconHammer from "@tabler/icons-react-native/IconHammer";
import IconHandStop from "@tabler/icons-react-native/IconHandStop";
import IconHeartHandshake from "@tabler/icons-react-native/IconHeartHandshake";
import IconHourglass from "@tabler/icons-react-native/IconHourglass";
import IconListCheck from "@tabler/icons-react-native/IconListCheck";
import IconLock from "@tabler/icons-react-native/IconLock";
import IconMessage from "@tabler/icons-react-native/IconMessage";
import IconMessageQuestion from "@tabler/icons-react-native/IconMessageQuestion";
import IconMovie from "@tabler/icons-react-native/IconMovie";
import IconPackage from "@tabler/icons-react-native/IconPackage";
import IconPalette from "@tabler/icons-react-native/IconPalette";
import IconPencil from "@tabler/icons-react-native/IconPencil";
import IconPrinter from "@tabler/icons-react-native/IconPrinter";
import IconRobot from "@tabler/icons-react-native/IconRobot";
import IconRocket from "@tabler/icons-react-native/IconRocket";
import IconSatellite from "@tabler/icons-react-native/IconSatellite";
import IconSearch from "@tabler/icons-react-native/IconSearch";
import IconServer from "@tabler/icons-react-native/IconServer";
import IconSettings from "@tabler/icons-react-native/IconSettings";
import IconSparkles from "@tabler/icons-react-native/IconSparkles";
import IconStar from "@tabler/icons-react-native/IconStar";
import IconStopwatch from "@tabler/icons-react-native/IconStopwatch";
import IconUsers from "@tabler/icons-react-native/IconUsers";
import IconWifi from "@tabler/icons-react-native/IconWifi";
import IconWorld from "@tabler/icons-react-native/IconWorld";
import IconZoomCode from "@tabler/icons-react-native/IconZoomCode";
import type { SessionBoxBaseIconId } from "@t3tools/shared/sessionBoxes";

/** Line icons drawn while a painted icon loads, or if one is missing. */
export const SESSION_BOX_FALLBACK_ICONS: Record<SessionBoxBaseIconId, Icon> = {
  "topic-app": IconAppWindow,
  "topic-mobile": IconDeviceMobile,
  "topic-website": IconWorld,
  "topic-server": IconServer,
  "topic-gpu": IconCpu,
  "topic-training": IconBrain,
  "topic-model": IconSparkles,
  "topic-benchmark": IconStopwatch,
  "topic-bug": IconBug,
  "topic-review": IconZoomCode,
  "topic-build": IconHammer,
  "topic-cleanup": IconEraser,
  "topic-network": IconWifi,
  "topic-devices": IconPrinter,
  "topic-security": IconLock,
  "topic-data": IconChartBar,
  "topic-research": IconBook,
  "topic-question": IconMessageQuestion,
  "topic-writing": IconFeather,
  "topic-design": IconPalette,
  "topic-media": IconMovie,
  "topic-science": IconAtom,
  "topic-bot": IconRobot,
  "topic-agents": IconUsers,
  "topic-money": IconCoins,
  "topic-settings": IconSettings,
  "topic-test": IconFlask,
  "topic-general": IconStar,
  "activity-thinking": IconBulb,
  "activity-replying": IconMessage,
  "activity-reading": IconEye,
  "activity-searching": IconSearch,
  "activity-editing": IconPencil,
  "activity-testing": IconListCheck,
  "activity-building": IconHammer,
  "activity-running": IconRocket,
  "activity-installing": IconPackage,
  "activity-git": IconGitBranch,
  "activity-browsing": IconCompass,
  "activity-remote": IconSatellite,
  "activity-gpu": IconCpu,
  "activity-delegating": IconHeartHandshake,
  "activity-waiting": IconHourglass,
  "state-asking": IconHandStop,
  "state-done": IconCheck,
  "state-failed": IconCircleX,
  "state-limited": IconGauge,
};
