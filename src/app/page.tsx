"use client";
import dynamic from "next/dynamic";

// Avoid SSR for recharts (it expects window)
const TelemetryExplorer = dynamic(
  () => import("./components/TelemetryExplorer"),
  { ssr: false }
);

export default function Page() {
  return (
    <main className="min-h-screen">
      <TelemetryExplorer />
    </main>
  );
}
