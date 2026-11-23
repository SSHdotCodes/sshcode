import { PROFILE_IMAGE_SIZE, profileCrop, profileImage } from "@t3tools/shared/discordProfile";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";

export async function resizeProfile(file: File) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
    throw new Error("Choose a PNG, JPEG or WebP under 10 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const crop = profileCrop(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = PROFILE_IMAGE_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image editing is unavailable.");
    context.beginPath();
    context.arc(80, 80, 80, 0, Math.PI * 2);
    context.clip();
    context.drawImage(
      bitmap,
      crop.originX,
      crop.originY,
      crop.width,
      crop.height,
      0,
      0,
      PROFILE_IMAGE_SIZE,
      PROFILE_IMAGE_SIZE,
    );
    const image = profileImage(canvas.toDataURL("image/png"));
    if (!image) throw new Error("Choose a simpler image.");
    return image;
  } finally {
    bitmap.close();
  }
}

const PROFILE_KEY = "sshcode.discord-profile.v1";
export function readProfile(storage: Pick<Storage, "getItem">) {
  try {
    return profileImage(storage.getItem(PROFILE_KEY));
  } catch {
    return null;
  }
}
export function writeProfile(
  storage: Pick<Storage, "setItem" | "removeItem">,
  image: string | null,
) {
  if (image === null) storage.removeItem(PROFILE_KEY);
  else {
    const valid = profileImage(image);
    if (!valid) throw new Error("Choose a valid profile image.");
    storage.setItem(PROFILE_KEY, valid);
  }
}
