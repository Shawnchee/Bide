import { brandImage } from "@/lib/brand-image";

export const dynamic = "force-static";

/** Square Blink card using the shared Bide identity. */
export function GET() {
  return brandImage(800, 800);
}
