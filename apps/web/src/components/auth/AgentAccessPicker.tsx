import { AuthMcpClientAccess } from "@t3tools/contracts";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { EyeIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { RadioGroup } from "../ui/radio-group";

export const agentAccessConfig: Record<
  AuthMcpClientAccess,
  { readonly label: string; readonly description: string; readonly icon: LucideIcon }
> = {
  "read-only": {
    label: "Read only",
    description: "Read projects and chats. Cannot start, message or change anything.",
    icon: EyeIcon,
  },
  ...runtimeModeConfig,
};

/** The most an outside agent may do, as the agent sign-in page and the app both ask it. */
export function AgentAccessPicker(props: {
  readonly value: AuthMcpClientAccess;
  readonly onChange: (access: AuthMcpClientAccess) => void;
  readonly labelledBy: string;
  readonly disabled?: boolean;
  readonly descriptions?: boolean;
  readonly disabledReason?: (access: AuthMcpClientAccess) => string | undefined;
}) {
  return (
    <RadioGroup
      aria-labelledby={props.labelledBy}
      disabled={props.disabled ?? false}
      value={props.value}
      onValueChange={(value) => props.onChange(value as AuthMcpClientAccess)}
    >
      {AuthMcpClientAccess.literals.map((option) => (
        <AccessOption
          key={option}
          access={option}
          selected={option === props.value}
          showDescription={props.descriptions !== false}
          disabledReason={props.disabledReason?.(option)}
        />
      ))}
    </RadioGroup>
  );
}

function AccessOption({
  access,
  selected,
  disabledReason,
  showDescription,
}: {
  readonly access: AuthMcpClientAccess;
  readonly selected: boolean;
  readonly showDescription: boolean;
  readonly disabledReason?: string | undefined;
}) {
  const { label, description, icon: Icon } = agentAccessConfig[access];
  return (
    <RadioPrimitive.Root
      value={access}
      disabled={disabledReason !== undefined}
      className={cn(
        "disabled:cursor-not-allowed disabled:opacity-50 flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "border-primary bg-background ring-2 ring-inset ring-primary/25 dark:border-transparent dark:bg-primary/10 dark:ring-1 dark:ring-primary/30"
          : "border-border bg-background hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          selected ? "text-primary" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {disabledReason || showDescription ? (
          <span className="block text-xs text-muted-foreground">
            {disabledReason ?? description}
          </span>
        ) : null}
      </span>
    </RadioPrimitive.Root>
  );
}
