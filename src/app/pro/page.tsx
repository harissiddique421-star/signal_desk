import type { Metadata } from "next";
import { Dashboard } from "@/components/Dashboard";

export const metadata: Metadata = { title: "Signal Desk — Pro view" };

export default function ProPage() {
  return <Dashboard />;
}
