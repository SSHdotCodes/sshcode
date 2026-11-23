import { useState } from "react";
import { Alert, Image, View } from "react-native";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { PROFILE_IMAGE_SIZE, profileImage, profileCrop } from "@t3tools/shared/discordProfile";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { AppText as Text } from "../../components/AppText";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";

export function DiscordProfileSetting({ inline = false }: { readonly inline?: boolean }) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const image = AsyncResult.isSuccess(preferences)
    ? profileImage(preferences.value.discordProfileImage)
    : null;
  const [busy, setBusy] = useState(false);
  const choose = async () => {
    setBusy(true);
    try {
      const picker = await import("expo-image-picker");
      const result = await picker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      if (asset.fileSize && asset.fileSize > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
        throw new Error("Choose an image under 10 MB.");
      const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
      const context = ImageManipulator.manipulate(asset.uri);
      context
        .crop(profileCrop(asset.width, asset.height))
        .resize({ width: PROFILE_IMAGE_SIZE, height: PROFILE_IMAGE_SIZE });
      const rendered = await context.renderAsync();
      const output = await rendered.saveAsync({
        format: SaveFormat.JPEG,
        compress: 0.8,
        base64: true,
      });
      const value = profileImage(`data:image/jpeg;base64,${output.base64 ?? ""}`);
      if (!value) throw new Error("Choose a simpler image.");
      save({ discordProfileImage: value });
    } catch (cause) {
      Alert.alert(
        "Couldn’t save that picture",
        cause instanceof Error ? cause.message : "Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const content = (
    <>
      <View className="flex-row items-center gap-3 px-4 py-2">
        <View className="size-10 items-center justify-center overflow-hidden rounded-full bg-card">
          {image ? (
            <Image source={{ uri: image }} style={{ width: 40, height: 40, borderRadius: 20 }} />
          ) : (
            <Text className="text-foreground">Y</Text>
          )}
        </View>
        <Text className="flex-1 text-xs text-foreground-muted">
          Your picture in Discord mode, saved on this phone.
        </Text>
      </View>
      <SettingsActionRow
        icon="photo"
        label="Choose image"
        loading={busy}
        disabled={busy}
        onPress={() => void choose()}
      />
      {image ? (
        <SettingsActionRow
          icon="trash"
          label="Remove picture"
          onPress={() => save({ discordProfileImage: null })}
        />
      ) : null}
    </>
  );
  return inline ? content : <SettingsSection title="Profile picture">{content}</SettingsSection>;
}
