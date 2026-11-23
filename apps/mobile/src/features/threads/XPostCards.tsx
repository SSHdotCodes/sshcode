import {
  loadXPostPreview,
  rememberedXPostPreview,
} from "@t3tools/client-runtime/state/xPostPreviews";
import type { EnvironmentId } from "@t3tools/contracts";
import { xPostLinks, type XPostLink } from "@t3tools/shared/xPostLinks";
import { Image as ExpoImage } from "expo-image";
import { memo, use, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { MarkdownImageAvailableWidthContext } from "./ThreadMarkdownImage";

const MAX_CARD_WIDTH = 360;
const THUMBNAIL = 60;

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

function XPostCard(props: {
  environmentId: EnvironmentId;
  link: XPostLink;
  width: number;
  onOpen: (url: string) => void;
}) {
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
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Post by ${preview.authorName} on X`}
      onPress={() => props.onOpen(preview.url)}
      style={{ width: props.width }}
      className="mt-2 flex-row items-center gap-3 rounded-2xl border border-border bg-card-alt px-3 py-2.5 active:opacity-70"
    >
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-1.5">
          <Text className="text-xs font-semibold text-foreground">𝕏</Text>
          <Text numberOfLines={1} className="shrink text-xs font-semibold text-foreground">
            {preview.authorName}
          </Text>
          <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
            @{preview.authorHandle}
          </Text>
          {date ? <Text className="text-xs text-foreground-muted">· {date}</Text> : null}
        </View>
        {preview.text ? (
          <Text numberOfLines={3} className="text-sm text-foreground-secondary">
            {preview.text}
          </Text>
        ) : null}
      </View>
      {preview.image && !imageFailed ? (
        <View
          style={{ width: THUMBNAIL, height: THUMBNAIL }}
          className="items-center justify-center overflow-hidden rounded-xl bg-card"
        >
          <ExpoImage
            source={{ uri: preview.image.url }}
            style={{ width: THUMBNAIL, height: THUMBNAIL }}
            contentFit="cover"
            accessible={false}
            onError={() => setImageFailed(true)}
          />
          {preview.image.video ? (
            <View className="absolute inset-0 items-center justify-center bg-black/25">
              <SymbolView name="play" size={16} tintColor="#ffffff" type="monochrome" />
            </View>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * Small cards for the X posts a message links to: who wrote it, the start of
 * the text and one picture. Display only; nothing here reaches the agent.
 */
export const XPostCards = memo(function XPostCards(props: {
  text: string;
  environmentId: EnvironmentId;
  onOpen: ((url: string) => void) | undefined;
}) {
  const links = useMemo(() => xPostLinks(props.text), [props.text]);
  const available = use(MarkdownImageAvailableWidthContext);
  const onOpen = props.onOpen;
  if (links.length === 0 || !onOpen || available <= 0) return null;
  const width = Math.min(available, MAX_CARD_WIDTH);
  return (
    // Each card carries its own top margin, so this takes no room while nothing is drawn.
    <View>
      {links.map((link) => (
        <XPostCard
          key={link.id}
          environmentId={props.environmentId}
          link={link}
          width={width}
          onOpen={onOpen}
        />
      ))}
    </View>
  );
});
