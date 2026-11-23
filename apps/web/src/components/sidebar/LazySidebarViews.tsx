import { lazy, Suspense, type ComponentProps } from "react";

const LegacySidebar = lazy(() => import("../LegacySidebar"));
const SettingsNavigation = lazy(() =>
  import("../settings/SettingsSidebarNav").then((module) => ({
    default: module.SettingsSidebarNav,
  })),
);

const loading = <div className="min-h-0 flex-1" aria-busy="true" />;

export function LegacyThreadSidebar() {
  return (
    <Suspense fallback={loading}>
      <LegacySidebar />
    </Suspense>
  );
}

export function SettingsSidebarNav(props: ComponentProps<typeof SettingsNavigation>) {
  return (
    <Suspense fallback={loading}>
      <SettingsNavigation {...props} />
    </Suspense>
  );
}
