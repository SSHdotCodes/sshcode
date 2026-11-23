import { harnessMascotForDriver } from "./harnessMascots.ts";
import { harnessMascotIdentity } from "./harnessThemes.ts";

/** Unrecognized harnesses use the same generic buddy as unthemed models. */
export function discordAvatarIdentity(input: Parameters<typeof harnessMascotIdentity>[0]) {
  const identity = harnessMascotIdentity(input);
  return harnessMascotForDriver(identity.driver, identity.agentId)
    ? identity
    : { driver: "acpRegistry", agentId: null };
}
export const PROFILE_IMAGE_MAX_LENGTH = 96_000;
export const PROFILE_IMAGE_SIZE = 160;
/** Device-local, bounded JPEG/PNG data only. Never load an arbitrary remote profile URL. */
export function profileImage(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= PROFILE_IMAGE_MAX_LENGTH &&
    /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    ? value
    : null;
}
export function profileCrop(width: number, height: number) {
  const size = Math.min(width, height);
  return {
    originX: Math.floor((width - size) / 2),
    originY: Math.floor((height - size) / 2),
    width: size,
    height: size,
  };
}
