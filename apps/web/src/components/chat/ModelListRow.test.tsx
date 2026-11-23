// @vitest-environment jsdom
import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { Combobox, ComboboxListVirtualized, ComboboxSearchInput } from "../ui/combobox";
import { ModelListRow, SortableModelRow } from "./ModelListRow";
import { modelPickerModelKey } from "./modelPickerKeys";

const instanceId = ProviderInstanceId.make("codex");
const slugs = ["sol", "terra"];
const keys = slugs.map((slug) => modelPickerModelKey(instanceId, slug));

function Favorites(props: { readonly onDragStart: (id: string) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  return (
    <Combobox<string> inline items={keys} filter={null} open virtualized>
      <ComboboxListVirtualized>
        <DndContext
          sensors={sensors}
          onDragStart={({ active }) => props.onDragStart(String(active.id))}
        >
          <SortableContext items={keys}>
            {slugs.map((slug, index) => (
              <SortableModelRow key={slug} id={keys[index]!}>
                {(reorderHandle) => (
                  <ModelListRow
                    index={index}
                    model={{ slug, name: slug }}
                    instanceId={instanceId}
                    driverKind={ProviderDriverKind.make("codex")}
                    providerDisplayName="Codex"
                    isFavorite
                    isSelected={false}
                    showProvider={false}
                    reorderHandle={reorderHandle}
                    onToggleFavorite={() => {}}
                  />
                )}
              </SortableModelRow>
            ))}
          </SortableContext>
        </DndContext>
      </ComboboxListVirtualized>
    </Combobox>
  );
}

let root: Root;
let container: HTMLDivElement;
const onDragStart = vi.fn<(id: string) => void>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Favorites onDragStart={onDragStart} />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  onDragStart.mockClear();
  vi.unstubAllGlobals();
});

const pointer = (type: string, clientY: number) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    isPrimary: true,
    button: 0,
    clientX: 10,
    clientY,
  });

it("starts a drag from a favorite's grip, though the row cancels every press", async () => {
  const grip = container.querySelectorAll('[aria-label="Reorder favorite"]')[1]!;
  const press = pointer("pointerdown", 10);
  act(() => void grip.dispatchEvent(press));
  act(() => void document.dispatchEvent(pointer("pointermove", 40)));

  expect(onDragStart).toHaveBeenCalledExactlyOnceWith(keys[1]);
  // The row still cancels the press, which keeps the cursor in the search box.
  expect(press.defaultPrevented).toBe(true);
  act(() => void document.dispatchEvent(pointer("pointerup", 40)));
  // dnd-kit keeps a capturing click blocker on the document for 50 ms after a drag. A later
  // test that selects by keyboard inside that window lost its click on a quiet machine.
  await new Promise((resolve) => setTimeout(resolve, 60));
});

it("leaves a press on the rest of the row to the list", () => {
  const row = container.querySelectorAll('[role="option"]')[1]!;
  act(() => void row.dispatchEvent(pointer("pointerdown", 10)));
  act(() => void document.dispatchEvent(pointer("pointermove", 40)));

  expect(onDragStart).not.toHaveBeenCalled();
  act(() => void document.dispatchEvent(pointer("pointerup", 40)));
});

it("keeps a credit-limited model selectable and explains why a retry may fail", async () => {
  const picked = vi.fn();
  await act(async () =>
    root.render(
      <Combobox<string> inline items={keys} filter={null} open virtualized onValueChange={picked}>
        <ComboboxSearchInput />
        <ComboboxListVirtualized>
          <ModelListRow
            index={0}
            model={{ slug: "sol", name: "Sol" }}
            instanceId={instanceId}
            driverKind={ProviderDriverKind.make("codex")}
            providerDisplayName="Codex"
            isFavorite={false}
            isSelected={false}
            showProvider
            creditWarning="Out of credit since 10:00 PM: Budget exhausted."
            onToggleFavorite={() => {}}
          />
        </ComboboxListVirtualized>
      </Combobox>,
    ),
  );
  const row = container.querySelector<HTMLElement>('[role="option"]')!;
  expect(row.textContent).toContain("Out of credit since 10:00 PM: Budget exhausted.");
  const input = container.querySelector("input")!;
  await act(async () => {
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(picked).toHaveBeenCalled();
});
