import type { Metadata } from "next";
import { TicketTracker } from "@/components/help/TicketTracker";

// A private tracking page: keep it out of search engines and don't leak its URL to other sites.
export const metadata: Metadata = { title: "Your ticket", robots: { index: false, follow: false } };

export default async function TicketPage({ params }: { params: Promise<{ ws: string; token: string }> }) {
  const { ws, token } = await params;
  return <TicketTracker ws={ws} token={token} />;
}
