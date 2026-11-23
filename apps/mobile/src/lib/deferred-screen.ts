import { createElement, type ComponentType } from "react";

/** Metro keeps literal requires in the bundle, but evaluates them only on render. */
export function deferredScreen<Props extends object>(load: () => ComponentType<Props>) {
  let component: ComponentType<Props> | undefined;
  return function DeferredScreen(props: Props) {
    component ??= load();
    return createElement(component, props);
  };
}
