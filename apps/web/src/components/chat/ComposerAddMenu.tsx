import { memo, useRef, useState } from "react";
import {
  CalendarClockIcon,
  HistoryIcon,
  ListTodoIcon,
  Columns2Icon,
  PaperclipIcon,
  PlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { subagentsOffConfirmation } from "@t3tools/shared/chatControls";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { questPanelRole } from "../../questBridge";
import { useComposerMenuProps } from "./composerEventScope";

export const ComposerAddMenu = memo(function ComposerAddMenu(props: {
  showAttachFiles: boolean;
  showComparison?: boolean;
  onScheduleMessage?: () => void;
  scheduleUnavailableReason?: string | null;
  onManageScheduledMessages?: () => void;
  comparisonEnabled: boolean;
  comparisonDisabled: boolean;
  onAttachFiles: () => void;
  /** Opens the list of prompts already sent in this chat. Absent while there are none. */
  onShowEarlierPrompts?: () => void;
  onComparisonChange: (enabled: boolean) => void;
  /** Absent hides the switch, so menus without a server chat stay unchanged. */
  existingThread?: boolean;
  subagentsEnabled?: boolean;
  onSubagentsChange?: (enabled: boolean) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const openingModelPicker = useRef(false);

  return (
    <Menu
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) openingModelPicker.current = false;
        setOpen(nextOpen);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Add menu"
                  data-discord-attach
                />
              }
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup>Add to chat</TooltipPopup>
      </Tooltip>
      <MenuPopup
        {...composerFloatingLayerProps}
        align="start"
        finalFocus={() => {
          // The model picker takes focus when comparison starts; closing this menu must not reclaim it.
          if (openingModelPicker.current) return false;
          return composerFloatingLayerProps.finalFocus?.() ?? true;
        }}
      >
        {props.showAttachFiles ? (
          <MenuItem onClick={props.onAttachFiles}>
            <PaperclipIcon />
            Attach files
          </MenuItem>
        ) : null}
        {props.onShowEarlierPrompts ? (
          <MenuItem
            onClick={() => {
              // The list takes focus; closing this menu must not reclaim it.
              openingModelPicker.current = true;
              props.onShowEarlierPrompts?.();
            }}
          >
            <HistoryIcon />
            Earlier prompts…
          </MenuItem>
        ) : null}
        {props.showComparison !== false ? (
          <MenuItem
            disabled={props.comparisonDisabled}
            onClick={() => {
              if (props.comparisonDisabled) return;
              openingModelPicker.current = !props.comparisonEnabled;
              props.onComparisonChange(!props.comparisonEnabled);
            }}
          >
            {props.comparisonEnabled ? <XIcon /> : <Columns2Icon />}
            {props.comparisonEnabled ? "Stop comparing" : "Compare models"}
          </MenuItem>
        ) : null}
        {props.onScheduleMessage ? (
          <MenuItem
            disabled={props.scheduleUnavailableReason != null}
            title={props.scheduleUnavailableReason ?? undefined}
            aria-description={props.scheduleUnavailableReason ?? undefined}
            onClick={() => {
              openingModelPicker.current = true;
              props.onScheduleMessage?.();
            }}
          >
            <CalendarClockIcon />
            Schedule message…
          </MenuItem>
        ) : null}
        {props.onManageScheduledMessages ? (
          <MenuItem onClick={props.onManageScheduledMessages}>
            <ListTodoIcon />
            Scheduled messages…
          </MenuItem>
        ) : null}
        {/* Rarely touched, so a chat's switch lives in its Agents panel. A Quest panel has none. */}
        {props.onSubagentsChange && questPanelRole() !== null ? (
          // A switch, not an action named after its state: "Subagents On" read as a command.
          <MenuCheckboxItem
            variant="switch"
            closeOnClick
            checked={props.subagentsEnabled !== false}
            onCheckedChange={(checked) => props.onSubagentsChange?.(checked)}
          >
            <span className="flex items-center gap-2">
              <UsersIcon aria-hidden className="size-4 shrink-0 opacity-80" />
              Subagents
            </span>
          </MenuCheckboxItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

export function SubagentsOffDialog(props: {
  modelLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = subagentsOffConfirmation(props.modelLabel);
  return (
    <AlertDialog open onOpenChange={(open) => (open ? undefined : props.onCancel())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.question}</AlertDialogTitle>
          <AlertDialogDescription>
            {copy.detail} {copy.secondary}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button onClick={props.onConfirm}>Turn off</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
