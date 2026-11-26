import { Check, Copy } from "lucide";
import { useRef } from "react";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { cn } from "../lib/utils";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "./ui/anchoredCopyToast";
import { Button } from "./ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function DiffFilePathCopyButton({ filePath }: { filePath: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });

  return (
    <span
      className={cn(
        "inline-flex opacity-(--diff-header-copy-opacity,1) transition-opacity duration-120 hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
        isCopied && "opacity-100",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={ref}
              size="icon-micro"
              variant="ghost-muted"
              aria-label="Copy file path"
              onClick={() => copyToClipboard(filePath, undefined)}
            />
          }
        >
          <MorphIcon
            className={cn("size-3", isCopied && "text-success")}
            icon={isCopied ? Check : Copy}
          />
        </TooltipTrigger>
        <TooltipPopup>
          <p>{isCopied ? "Copied" : "Copy path"}</p>
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}
