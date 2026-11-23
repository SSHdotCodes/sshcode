import {
  loadXPostPreview,
  rememberedXPostPreview,
} from "@t3tools/client-runtime/state/xPostPreviews";
import type { EnvironmentId } from "@t3tools/contracts";
import { xPostLinks, type XPostLink } from "@t3tools/shared/xPostLinks";
import { PlayIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState, type MouseEvent } from "react";

import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

function postDate(createdAt: string | null): string | null {
  const time = createdAt === null ? Number.NaN : Date.parse(createdAt);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function XPostCard(props: { environmentId: EnvironmentId; link: XPostLink }) {
  const { environmentId, link } = props;
  const read = useAtomCommand(serverEnvironment.getXPostPreview, { reportFailure: false });
  const key = `${environmentId}:${link.id}`;
  // The card is drawn from what is remembered; a finished lookup only asks for a redraw.
  const [, redraw] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const preview = rememberedXPostPreview(key) ?? null;

  useEffect(() => {
    if (rememberedXPostPreview(key) !== undefined) return;
    let cancelled = false;
    void loadXPostPreview(key, () =>
      read({ environmentId, input: { url: link.url } }).then((result) =>
        result._tag === "Success" ? result.value : undefined,
      ),
    ).then((value) => {
      if (!cancelled && value) redraw((count) => count + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, key, link.url, read]);

  if (preview === null) return null;
  const date = postDate(preview.createdAt);
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isElectron) return;
    event.preventDefault();
    void readLocalApi()?.shell.openExternal(preview.url);
  };
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noreferrer"
      onClick={open}
      data-x-post-card={link.id}
      className="flex w-full max-w-md items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-3 py-2.5 text-left text-foreground no-underline transition-colors hover:border-border hover:bg-accent/50"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <XLogo className="size-3 shrink-0 text-foreground" />
          <span className="truncate font-medium text-foreground">{preview.authorName}</span>
          <span className="min-w-0 shrink-[2] truncate">@{preview.authorHandle}</span>
          {date ? <span className="shrink-0">· {date}</span> : null}
        </span>
        {preview.text ? (
          <span className="line-clamp-3 text-sm leading-snug whitespace-pre-line text-foreground/85">
            {preview.text}
          </span>
        ) : null}
      </span>
      {preview.image && !imageFailed ? (
        <span className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-border/40 bg-muted">
          <img
            src={preview.image.url}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            draggable={false}
            className="size-full object-cover"
            onError={() => setImageFailed(true)}
          />
          {preview.image.video ? (
            <span className="absolute inset-0 grid place-items-center bg-black/25">
              <PlayIcon className="size-4 fill-white text-white" />
            </span>
          ) : null}
        </span>
      ) : null}
    </a>
  );
}

/**
 * Small cards for the X posts a message links to: who wrote it, the start of
 * the text and one picture. Display only; nothing here reaches the agent.
 */
export const XPostEmbeds = memo(function XPostEmbeds(props: {
  text: string;
  environmentId: EnvironmentId | null | undefined;
  className?: string;
}) {
  const links = useMemo(() => xPostLinks(props.text), [props.text]);
  if (links.length === 0 || !props.environmentId) return null;
  return (
    <div className={props.className ?? "mt-2 flex flex-col gap-1.5 empty:hidden"}>
      {links.map((link) => (
        <XPostCard key={link.id} environmentId={props.environmentId!} link={link} />
      ))}
    </div>
  );
});
