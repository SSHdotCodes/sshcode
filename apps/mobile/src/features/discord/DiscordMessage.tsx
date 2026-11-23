import { useContext, useState, type ReactNode } from "react";
import { Image, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import {
  HarnessMascot,
  HarnessMascotDriver,
  HarnessMascotAgentId,
} from "../../components/HarnessMascot";
import { discordAvatarIdentity, profileImage } from "@t3tools/shared/discordProfile";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom } from "../../state/preferences";
import type { TimelineDecoration } from "./timelinePresentation";

export function TimelineDividers(props: { readonly decoration?: TimelineDecoration }) {
  return (
    <>
      {props.decoration?.day ? (
        <View className="my-4 flex-row items-center gap-3">
          <View className="h-px flex-1 bg-border" />
          <Text style={{ fontSize: 12, fontWeight: "600" }} className="text-foreground-muted">
            {props.decoration.day}
          </Text>
          <View className="h-px flex-1 bg-border" />
        </View>
      ) : null}
      {props.decoration?.isNew ? (
        <View accessibilityLabel="New messages" className="my-2 flex-row items-center">
          <View className="h-px flex-1 bg-danger-foreground" />
          <View className="rounded-full bg-danger-foreground px-2 py-0.5">
            <Text style={{ fontSize: 10, fontWeight: "700", color: "#FFFFFF" }}>NEW</Text>
          </View>
        </View>
      ) : null}
    </>
  );
}

export function DiscordMessage(props: {
  readonly children: ReactNode;
  readonly author: string;
  readonly driver?: string | null;
  readonly avatar?: ReturnType<typeof discordAvatarIdentity> | undefined;
  readonly assistant: boolean;
  readonly grouped: boolean;
  readonly timestamp: string;
}) {
  const driver = useContext(HarnessMascotDriver);
  const agentId = useContext(HarnessMascotAgentId);
  const identity =
    props.avatar ?? discordAvatarIdentity({ driver: driver ?? props.driver, agentId });
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const image = AsyncResult.isSuccess(preferences)
    ? profileImage(preferences.value.discordProfileImage)
    : null;
  return (
    <View
      style={{
        paddingTop: props.grouped ? 0 : 17,
        paddingLeft: 52,
        minHeight: props.grouped ? undefined : 57,
      }}
    >
      {!props.grouped ? (
        <>
          <View
            style={{
              position: "absolute",
              left: 0,
              top: 17,
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: props.assistant ? "#5865F2" : "#4E5058",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            {props.assistant ? (
              <HarnessMascot driver={identity.driver} agentId={identity.agentId} size={40} still />
            ) : image && failedImage !== image ? (
              <Image
                source={{ uri: image }}
                style={{ width: 40, height: 40, borderRadius: 20 }}
                onError={() => setFailedImage(image)}
              />
            ) : (
              <Text style={{ color: "#FFFFFF", fontSize: 18 }}>
                {props.author.charAt(0).toUpperCase()}
              </Text>
            )}
          </View>
          <View className="mb-0.5 flex-row flex-wrap items-center gap-1.5">
            <Text style={{ fontSize: 16, fontWeight: "500" }} className="text-foreground">
              {props.author}
            </Text>
            {props.assistant ? (
              <View
                style={{
                  backgroundColor: "#5865F2",
                  borderRadius: 3,
                  paddingHorizontal: 4,
                  height: 15,
                  justifyContent: "center",
                  overflow: "hidden",
                }}
              >
                <Text style={{ color: "#FFFFFF", fontSize: 10, fontWeight: "700" }}>APP</Text>
              </View>
            ) : null}
            <Text className="text-foreground-muted" style={{ fontSize: 12, marginLeft: 4 }}>
              {new Date(props.timestamp).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </Text>
          </View>
        </>
      ) : null}
      {props.children}
    </View>
  );
}
