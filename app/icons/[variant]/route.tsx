import { ImageResponse } from "next/og";
import { markSvg } from "@/lib/brand";

type Ctx = { params: Promise<{ variant: string }> };

// /icons/192, /icons/512, /icons/1024, /icons/maskable-512 …
export async function GET(_req: Request, ctx: Ctx) {
  const variant = (await ctx.params).variant;
  const maskable = variant.startsWith("maskable");
  const size = Math.min(1024, Math.max(16, Number(variant.replace(/\D/g, "")) || 512));
  const src = `data:image/svg+xml;base64,${Buffer.from(markSvg({ maskable })).toString("base64")}`;
  const image = new ImageResponse(
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} width={size} height={size} alt="" />,
    { width: size, height: size },
  );
  image.headers.set("cache-control", "public, max-age=604800, immutable");
  return image;
}
