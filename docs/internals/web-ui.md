# Web UI

## Primitives

Controls come from [`components/ui`](../../apps/web/src/components/ui).
[AGENTS.md](../../AGENTS.md#taste) says how to use and extend them.

Don't style a raw `<button>`, `<input>`, `<select>`, or `<textarea>` to look like a control a
primitive provides. Raw elements are right when the element isn't that control: semantic rows, tabs,
resize handles, swatches, editor surfaces, anything whose behavior or geometry differs by design.

## Styles

Style with Tailwind classes in the component that renders the element.

- Global CSS, in [`index.css`](../../apps/web/src/index.css) or any other stylesheet, is only for
  what classes on the owning component can't express: generated Markdown or imperative DOM, custom
  elements and shadow roots, animations, runtime theme variables, and browser or Electron
  integration.
- No `style={{ ... }}` or inline `<style>` for static values a class covers. Values computed at
  runtime are fine.
- Theme-only rules use `@variant dark` and `@variant light`, not `.dark` selectors.

## Composition

The composer banners are the reference.

- [`ComposerBanner.tsx`](../../apps/web/src/components/chat/ComposerBanner.tsx) exports one object
  of small slots. Slots own their classes, take `className`, and spread the rest of their props,
  merging classes with `cn`. Variants and density are props on `Root`. A slot that needs a control
  renders `Button`.
- [`ComposerBannerStack.tsx`](../../apps/web/src/components/chat/ComposerBannerStack.tsx) composes
  the slots and owns only stack behavior: priority, expand and collapse, dismiss transitions.
- Consumers are a few lines of slots, and the slots carry the styling:
  [`ComposerActivityStatus.tsx`](../../apps/web/src/components/chat/ComposerActivityStatus.tsx).

Build new UI the same way. Compose or extend a component instead of copying its markup and classes.
When a call site repeats a treatment another one already uses, make it a variant or a slot on the
shared component. A new composer banner or notice uses the `ComposerBanner` slots.

## Handlers in large components

V8 gives every closure created in one render a single shared scope. A memoized handler keeps
the scope of the render that created it, and that scope holds the other memoized values of that
render. When handlers in one component change at different times, each keeps an older scope that
holds older handlers, and old renders, with their server config and thread data, stay in memory
for as long as the component is mounted. React Compiler's memoized closures do the same.

In large, long-lived components such as `ChatView` and `ChatComposer`, write handlers as plain
functions and wrap them with [`useStableCallback`](../../apps/web/src/hooks/useStableCallback.ts)
only where they leave the component: props, hook dependency arrays, and effect or memo bodies.
Calls inside the component keep the plain function, so work that resumes after an `await` still
acts on the render it started in. A function that a child calls during render, or after an
`await`, comes from a module-level factory memoized on its inputs, so its closure keeps only
those inputs.

## Kept chat views

[`SplitChatSurface`](../../apps/web/src/components/chat/SplitChatSurface.tsx) keeps the last few
chats mounted, hidden by `<Activity>` in
[`KeptChatPane`](../../apps/web/src/components/chat/KeptChatPane.tsx), so switching back only
reveals them. Hiding keeps a view's state and DOM, but stops its effects and detaches its refs, and
revealing runs them again before the first frame. So:

- A hidden pane renders the same element tree as a shown one. A different wrapper remounts the chat.
- A chat view reads its own thread, not the route. A selector over the whole location re-renders
  every kept view on each navigation.
- Keep an element from a callback ref with
  [`useElementState`](../../apps/web/src/hooks/useElementState.ts). Plain state drops to null on
  hide, and the reveal then re-renders and re-measures the chat.
- Layout and passive effect cleanups run on hide too. A cleanup that resets measured or parent state
  costs a re-render and a style recalculation on every reveal. Work that belongs to unmount alone
  goes in a `useInsertionEffect` cleanup, which hiding skips and dropping a hidden pane still runs;
  it must not set state during the commit, so defer that a microtask. Tiptap's `useEditor` destroys
  its editor on hide, so the composer uses
  [`useKeptEditor`](../../apps/web/src/hooks/useKeptEditor.ts).
- Hidden chats stay in the document. A document-wide lookup (an id, an open popup) skips them with
  `isRenderedElement` from
  [`keptChatViews.ts`](../../apps/web/src/components/chat/keptChatViews.ts).
