import { brandImage } from "@/lib/brand-image";

export const alt = "Bide — Name your price. Get paid until it fills.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return brandImage(size.width, size.height);
}
