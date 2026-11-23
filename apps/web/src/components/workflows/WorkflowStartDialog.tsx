import type { WorkflowIssue } from "@t3tools/contracts";
import { CircleAlertIcon, PlayIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { issueKey } from "./workflowGraph";

/** Asks for the task a run should do; blocking issues show instead of the form. */
export function WorkflowStartDialog({
  open,
  onOpenChange,
  workflowName,
  issues,
  onShowIssues,
  onStart,
  initialTask = "",
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly workflowName: string;
  readonly issues: ReadonlyArray<WorkflowIssue>;
  readonly onShowIssues: () => void;
  readonly onStart: (task: string) => Promise<string | null>;
  /** Prefills the task, e.g. to run a finished run again. */
  readonly initialTask?: string;
}) {
  const [task, setTask] = useState(initialTask);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = issues.length > 0;
  const submit = async () => {
    const trimmed = task.trim();
    if (!trimmed || starting || blocked) return;
    setStarting(true);
    setError(null);
    const failure = await onStart(trimmed);
    setStarting(false);
    if (failure) setError(failure);
    else setTask("");
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Start {workflowName}</DialogTitle>
            <DialogDescription>
              The lead gets this task and hands work down the boxes you drew.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {blocked ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm">Fix these first:</p>
                <ul className="flex flex-col gap-1.5">
                  {issues.slice(0, 6).map((issue) => (
                    <li
                      key={issueKey(issue)}
                      className="flex items-start gap-2 text-sm text-destructive"
                    >
                      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <Textarea
                autoFocus
                aria-label="Task"
                placeholder="What should this run do?"
                value={task}
                maxLength={20_000}
                onChange={(event) => setTask(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            )}
            {error ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            {blocked ? (
              <Button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onShowIssues();
                }}
              >
                Show on canvas
              </Button>
            ) : (
              <Button type="submit" disabled={!task.trim() || starting}>
                {starting ? <Spinner /> : <PlayIcon />}
                Start run
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
