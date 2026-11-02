import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import defaultFocus from "./safety-focus-default.html?raw";

// The monthly safety focus: a page the Health & Safety team edit in their
// own SharePoint file (see safety_focus.rs). The copy saved last time shows
// at once; a newer one, fetched in the background once the app's start-up
// downloads are done, cross-fades in. Pages run in a sandbox without
// scripts, so they can only show content.

const FADE_MS = 800;
/** The newer version is looked for once per launch. */
let refreshStarted = false;

interface Layer { key: number; html: string; shown: boolean }

export function SafetyFocus() {
  const [layers, setLayers] = useState<Layer[]>([]);
  const current = useRef("");

  const show = (html: string) => {
    if (!html || html === current.current) return;
    const first = !current.current;
    current.current = html;
    // The new page goes on top, hidden until it has loaded.
    setLayers(prev => [...prev.slice(-1), { key: Date.now(), html, shown: first }]);
  };
  const loaded = (key: number) => {
    setLayers(prev => prev.map(l => (l.key === key ? { ...l, shown: true } : l)));
    // Once faded in, the page underneath is no longer needed.
    window.setTimeout(() => setLayers(prev => prev.filter(l => l.key >= key)), FADE_MS + 100);
  };

  useEffect(() => {
    invoke<string | null>("get_safety_focus").then(saved => show(saved || defaultFocus), () => show(defaultFocus));
    // Look for a newer version once per launch, after the project list has
    // downloaded (it holds the file's link, and the app's Edge is free again).
    const refresh = () => {
      if (refreshStarted) return;
      refreshStarted = true;
      invoke<string | null>("refresh_safety_focus").then(fresh => { if (fresh) show(fresh); }, () => { /* keep the saved copy */ });
    };
    if ((window as unknown as { roamProjectDataReady?: boolean }).roamProjectDataReady) refresh();
    else window.addEventListener("roam-project-data", refresh, { once: true });
    return () => window.removeEventListener("roam-project-data", refresh);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div aria-label="Safety focus" style={{ position: "absolute", inset: 0, overflow: "hidden", backgroundColor: "#2F3C46" }}>
      {layers.map(l => (
        <iframe
          key={l.key}
          title="Safety focus"
          srcDoc={l.html}
          sandbox=""
          onLoad={() => loaded(l.key)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none", opacity: l.shown ? 1 : 0, transition: `opacity ${FADE_MS}ms ease`, pointerEvents: "none" }}
        />
      ))}
    </div>
  );
}
