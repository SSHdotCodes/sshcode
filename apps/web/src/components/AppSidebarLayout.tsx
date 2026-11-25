import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";

import { useUiMode } from "../hooks/useTheme";
import { isElectron } from "../env";
import { questPanelRole } from "../questBridge";
import { QuestPanelCoordinator } from "./QuestPanelCoordinator";
import { getLocalStorageItem, removeLocalStorageItem } from "../hooks/useLocalStorage";
import {
  isRichTextBoldShortcut,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { resolveThreadRouteRef } from "../threadRoutes";
import { cn, isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  useClientSettings,
  useEnvironmentIdentificationMode,
  useLegacySidebarEnabled,
} from "../hooks/useSettings";
import {
  PanelAnimationSuppressionProvider,
  usePanelAnimationSettings,
  usePanelNavigationSuppression,
} from "../panelAnimations";
import { useThreadVisitedMigration } from "../hooks/useThreadVisitedMigration";
import ThreadSidebar from "./Sidebar";
import { LegacyThreadSidebar, SettingsSidebarNav } from "./sidebar/LazySidebarViews";
import { SidebarAttentionSource } from "./Sidebar.attentionSource";
import { useSidebarPeek } from "./Sidebar.peek";
import {
  SidebarAttentionBadge,
  sidebarAttentionCountsAtom,
  sidebarAttentionDescription,
} from "./Sidebar.attention";
import { SidebarBrandWidthProbe, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { MainAppLocationTracker } from "./sidebar/mainAppLocation";
import { WorkflowRunChatsTracker } from "./workflows/WorkflowRunChatsTracker";
import { useSidebarStageBackdropVariant } from "./SidebarStageBackdrop";
import { useProjects } from "../state/entities";
import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarMinimumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "var(--desktop-window-controls-inset, 90px)";

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

function readInitialThreadSidebarWidth(): number {
  try {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
    );
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return resolveInitialThreadSidebarWidth(null);
  }
}

function readInitialDiscordSidebarWidth(): number {
  try {
    return getLocalStorageItem("t3code:discord:sidebar-width:v1", Schema.Finite) ?? 312;
  } catch (error) {
    console.error("Could not read persisted Discord sidebar width.", error);
    return 312;
  }
}

function SidebarControl() {
  const attention = useAtomValue(sidebarAttentionCountsAtom);
  const [uiMode] = useUiMode();
  const settingsPageOpen = useLocation({
    select: (location) => location.pathname.startsWith("/settings"),
  });
  const usagePageOpen = useLocation({ select: (location) => location.pathname === "/usage" });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar, isMobile, mobileSheetMounted } = useSidebar();
  const isSidebarVisible = useSidebarVisibility();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle", {
    context: { usagePageOpen },
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (
        isRichTextBoldShortcut(event, window.getSelection()) &&
        event.target instanceof HTMLElement &&
        event.target.closest('[data-composer-rich-text="true"]')
      ) {
        // The rich-text composer claims Mod+B only to bold selected text;
        // the toggle stays available everywhere else.
        return;
      }
      if (
        resolveShortcutCommand(event, keybindings, { context: { usagePageOpen } }) !==
        "sidebar.toggle"
      )
        return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    // Capture before focused editors consume commands such as Mod+B for rich-text formatting.
    window.addEventListener("keydown", onKeyDown, true);
    // A focused desktop browser page forwards the chord as a menu action.
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "sidebar.toggle") toggleSidebar();
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unsubscribe?.();
    };
  }, [keybindings, toggleSidebar, usagePageOpen]);

  if (uiMode === "discord" && isSidebarVisible && !settingsPageOpen) return null;
  return (
    // The right-side layout controls carry mr-px (border compensation inside
    // the panel), so the trigger mirrors it: both clusters sit one extra pixel
    // off their edge and the titlebar reads symmetric.
    // The sheet owns its trigger until its closing transition unmounts it.
    <div
      className={cn(
        "pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center",
        isMobile && mobileSheetMounted && "hidden",
      )}
      data-sidebar-control=""
    >
      <div className="relative">
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarTrigger
                // Over the stage artwork the trigger is a control on imagery, like the media
                // viewer's arrows; that variant positions itself, so the layout is reset here.
                variant={isSidebarVisible && stageBackdropVariant ? "media-navigation" : "ghost"}
                className={cn(
                  "pointer-events-auto",
                  isSidebarVisible && stageBackdropVariant && "relative top-auto translate-y-0",
                )}
                aria-label="Toggle main sidebar"
                aria-description={
                  !isSidebarVisible && !settingsPageOpen
                    ? sidebarAttentionDescription(attention)
                    : undefined
                }
              />
            }
          />
          <TooltipPopup side="bottom">
            Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
            {!isSidebarVisible && !settingsPageOpen ? (
              <span className="mt-1 block">{sidebarAttentionDescription(attention)}</span>
            ) : null}
          </TooltipPopup>
        </Tooltip>
        {!isSidebarVisible &&
        !settingsPageOpen &&
        (attention.unread > 0 || attention.needsYou > 0) ? (
          <SidebarAttentionBadge counts={attention} />
        ) : null}
      </div>
    </div>
  );
}

// Moves through the app's route history like a browser's back/forward buttons.
function NavigationHistoryShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeThreadRef
            ? selectThreadTerminalUiState(
                useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
                routeThreadRef,
              ).terminalOpen
            : false,
          previewFocus: isPreviewFocused(),
          previewOpen: routeThreadRef
            ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, routeThreadRef) ===
              "preview"
            : false,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "navigation.back" && command !== "navigation.forward") return;

      event.preventDefault();
      event.stopPropagation();
      if (command === "navigation.back") window.history.back();
      else window.history.forward();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, routeThreadRef]);

  return null;
}

// Settings swaps the thread sidebar out of the tree. Keep the lightweight
// project projection subscribed so returning to a draft never renders the
// zero-project state while the environment snapshot reconnects.
function ProjectProjectionRetention() {
  useProjects();
  return null;
}

/**
 * The app sidebar. While collapsed it slides out over the page when the pointer rests on the
 * window's left edge, and slides away again once the pointer leaves it.
 */
function PeekableSidebar({ className, ...props }: ComponentProps<typeof Sidebar>) {
  const { isMobile, state } = useSidebar();
  const peekEnabled = useClientSettings((settings) => settings.sidebarPeekEnabled);
  const canPeek = peekEnabled && !isMobile && state === "collapsed";
  const peek = useSidebarPeek(canPeek);

  return (
    <>
      <Sidebar
        {...props}
        {...peek.sidebarHandlers}
        data-peek={peek.peeking ? "true" : undefined}
        className={cn(
          "data-[peek=true]:z-40 data-[peek=true]:translate-x-0! data-[peek=true]:shadow-[0_0_0_1px_rgb(0_0_0/0.05),16px_0_40px_-20px_rgb(0_0_0/0.5)]",
          className,
        )}
      />
      {canPeek ? (
        <div
          aria-hidden="true"
          data-sidebar-peek-edge=""
          className="fixed inset-y-0 left-0 z-30 hidden w-1.5 [-webkit-app-region:no-drag] md:block"
          {...peek.edgeHandlers}
        />
      ) : null}
    </>
  );
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const panelMode = questPanelRole() !== null;
  const navigate = useNavigate();
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const [uiMode] = useUiMode();
  const discordMode = uiMode === "discord";
  const [discordSidebarWidth, setDiscordSidebarWidth] = useState(readInitialDiscordSidebarWidth);
  const {
    active: panelAnimationsActive,
    durationMs: panelAnimationDurationMs,
    exitDurationMs: panelExitDurationMs,
  } = usePanelAnimationSettings();
  // Settings routes show the settings nav in place of whichever thread
  // sidebar is active.
  // Seeds server-side visited tracking from this browser's localStorage the
  useThreadVisitedMigration();
  const pathname = useLocation({ select: (location) => location.pathname });
  const panelAnimationsSuppressed = usePanelNavigationSuppression(pathname);
  const routePanelAnimationsActive = panelAnimationsActive && !panelAnimationsSuppressed;
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  // Subscribed rather than read once: the clamp must track live window size,
  // and a clamped drag ends with an unchanged width, which skips the re-render
  // that would otherwise refresh a render-time snapshot.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const [brandWidth, setBrandWidth] = useState(0);
  const sidebarMinimumWidth = discordMode ? 280 : resolveThreadSidebarMinimumWidth(brandWidth);
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(viewportWidth, sidebarMinimumWidth);
  const resetSidebarWidth = () => {
    try {
      removeLocalStorageItem(
        discordMode ? "t3code:discord:sidebar-width:v1" : THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
      );
    } catch (error) {
      console.error("Could not clear persisted thread sidebar width.", error);
    }
    if (discordMode) setDiscordSidebarWidth(312);
    else setSidebarWidth(resolveInitialThreadSidebarWidth(null));
  };
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(() => {
    const getWindowFullscreenState = window.desktopBridge?.getWindowFullscreenState;
    return isMacosDesktop && typeof getWindowFullscreenState === "function"
      ? getWindowFullscreenState()
      : false;
  });
  const windowControlsInsetStyle = (
    isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}
  ) as CSSProperties;
  const sidebarProviderStyle = {
    "--sidebar-width": `${clampThreadSidebarWidth(discordMode ? discordSidebarWidth : sidebarWidth, sidebarMinimumWidth, sidebarMaximumWidth)}px`,
    "--panel-animation-duration": `${panelAnimationDurationMs}ms`,
    "--panel-exit-duration": `${panelExitDurationMs}ms`,
    ...windowControlsInsetStyle,
  } as CSSProperties;

  useEffect(() => {
    if (!isMacosDesktop) return;
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const { getWindowFullscreenState, onWindowFullscreenStateChange } = bridge;
    if (
      typeof getWindowFullscreenState !== "function" ||
      typeof onWindowFullscreenStateChange !== "function"
    ) {
      return;
    }

    const unsubscribe = onWindowFullscreenStateChange(setIsWindowFullscreen);
    setIsWindowFullscreen(getWindowFullscreenState());
    return unsubscribe;
  }, [isMacosDesktop]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  return (
    <PanelAnimationSuppressionProvider value={panelAnimationsSuppressed}>
      <SidebarProvider
        className="h-dvh! min-h-0!"
        data-panel-animations={routePanelAnimationsActive ? "true" : "false"}
        defaultOpen={!panelMode}
        style={sidebarProviderStyle}
      >
        <SidebarBrandWidthProbe onWidthChange={setBrandWidth} />
        <ProjectProjectionRetention />
        <SidebarAttentionSource />
        {!panelMode ? (
          <PeekableSidebar
            side="left"
            collapsible="offcanvas"
            data-app-sidebar=""
            role="navigation"
            aria-label={isOnSettings ? "Settings" : "Chats"}
            resizable={{
              maxWidth: sidebarMaximumWidth,
              minWidth: sidebarMinimumWidth,
              shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
                nextWidth <= currentWidth ||
                wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
              storageKey: discordMode
                ? "t3code:discord:sidebar-width:v1"
                : THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
              onResize: discordMode ? setDiscordSidebarWidth : setSidebarWidth,
            }}
            // The narrow-window sidebar is a sheet, portaled outside the provider's styles.
            style={windowControlsInsetStyle}
          >
            {isOnSettings ? (
              <>
                <SidebarChromeHeader isElectron={isElectron} />
                <SettingsSidebarNav pathname={pathname} />
              </>
            ) : legacySidebarEnabled && !discordMode ? (
              <LegacyThreadSidebar />
            ) : (
              <ThreadSidebar />
            )}
            <SidebarRail onDoubleClick={resetSidebarWidth} />
          </PeekableSidebar>
        ) : null}
        {children}
        {panelMode ? <QuestPanelCoordinator /> : <SidebarControl />}
        <NavigationHistoryShortcuts />
        <MainAppLocationTracker />
        <WorkflowRunChatsTracker />
      </SidebarProvider>
    </PanelAnimationSuppressionProvider>
  );
}
