import type { Metadata } from "next";
import { HelpCenter } from "@/components/help/HelpCenter";

export const metadata: Metadata = { title: "Help centre" };

export default async function HelpPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <HelpCenter ws={ws} />;
}
