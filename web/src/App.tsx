import { useEffect, useState } from "react";
import { Overview } from "./pages/Overview";
import { Upload } from "./pages/Upload";
import { Connectors } from "./pages/Connectors";
import { Replay } from "./pages/Replay";
import { Simulation } from "./pages/Simulation";
import { ModeBadge } from "./components/ui";

const TABS = [
  { key: "overview", label: "Overview (LIVE)" },
  { key: "upload", label: "Upload data" },
  { key: "connectors", label: "API connectors" },
  { key: "replay", label: "Replay" },
  { key: "simulation", label: "Simulation" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export function App() {
  const initial = (window.location.hash.slice(1) as Tab) || "overview";
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.key === initial) ? initial : "overview");
  useEffect(() => {
    window.location.hash = tab;
  }, [tab]);

  return (
    <>
      <header className="app">
        <h1>Virtual Factory</h1>
        <nav aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.key} aria-current={tab === t.key ? "page" : undefined} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
        {tab === "overview" && <ModeBadge mode="LIVE" />}
        {tab === "replay" && <ModeBadge mode="REPLAY" />}
        {tab === "simulation" && <ModeBadge mode="SIMULATION" />}
      </header>
      <main>
        {tab === "overview" && <Overview />}
        {tab === "upload" && <Upload />}
        {tab === "connectors" && <Connectors />}
        {tab === "replay" && <Replay />}
        {tab === "simulation" && <Simulation />}
      </main>
    </>
  );
}
