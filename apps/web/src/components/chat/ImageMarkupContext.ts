import { createContext } from "react";
import type { ExpandedImageItem } from "./ExpandedImagePreview";

export const ImageMarkupContext = createContext<{
  isDraft: (item: ExpandedImageItem) => boolean;
  attach: (file: File, item: ExpandedImageItem, replace: boolean) => Promise<void>;
} | null>(null);
