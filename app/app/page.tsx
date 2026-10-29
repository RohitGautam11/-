import type { Metadata } from "next";
import VartalapApp from "@/components/app/VartalapApp";

export const metadata: Metadata = { title: "Chats" };

export default function AppPage() {
  return <VartalapApp />;
}
