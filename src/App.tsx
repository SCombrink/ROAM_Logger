import { useState, useEffect, useRef } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { WarmupOverlay } from "./WarmupOverlay";
import type { WarmupState } from "./types";
import { MonthlySidebar } from "./MonthlySidebar";
import { NameSearchModal } from "./NameSearchModal";
import { CrewModal, type PasteResult } from "./CrewModal";
import { AlertIcon, CalendarIcon, CheckCircleIcon, CheckIcon, MonitorIcon, MoonIcon, SunIcon, ClockIcon, CloseIcon, ConnectionIcon, SpinnerIcon, WarningIcon, EyeIcon, EyeOffIcon, InfoIcon, LockIcon, MicIcon, NewChatIcon, SendIcon, StopIcon } from "./icons";
import { countsForObserver, displayName, generateRandomMonthlyCounts, localAdjustments, MONTHLY_TARGET, nudgeMessage, NUDGE_COOLDOWN_DAYS, rankLeaderboard, reconcileLocal, updatedAgo, type Leaderboard, type LocalObservation, type ObservationCounts } from "./observationStats";

// Default empty lists used until SharePoint fetch populates them at runtime.
// Defined at module scope so the App component can reference them when
// initialising state. After the project-data fetch completes successfully
// these are replaced via setProjectsList/setCitiesList/setStreetsList.
const PROJECTS_LIST_DEFAULT: string[] = [];
const CITIES_LIST_DEFAULT: string[] = [];
const STREETS_LIST_DEFAULT: string[] = [];

interface ProjectData {
  schemaVersion: number;
  generatedAt?: string;
  feedbackEmail?: string;
  roamFormUrl?: string;
  roamAuthWhitelist?: string;
  projects: string[];
  cities: string[];
  streets: string[];
}
interface ProjectDataResult {
  data: ProjectData;
  ageDays: number | null;
  fromCache: boolean;
}
import { QRCodeSVG } from "qrcode.react";


interface Message {
  role: 'user' | 'ai';
  content: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: (event: any) => void;
  onerror: (event: any) => void;
  onend: () => void;
  onsoundstart?: () => void;
  onsoundend?: () => void;
}

// Project, city, and street lists are loaded from SharePoint at runtime via
// fetch_project_data. The source code intentionally contains no Hatch-specific
// data so the repo can safely be public.

const CATEGORIES_LIST = [
    "Access Breach", "Barricading", "Behaviour / General Conduct", "Caught Between", "Chemical", 
    "Collision", "Confined Space", "Contact With", "Cybersecurity", "Electrical", "Equipment Failure",
    "Ergonomics / Manual Handling", "Excavation", "Explosion", "Fall from Above", 
    "Fall from Above Objects", "Fall from Above Slips/Trips/Falls", "Fire", "Fire Prevention / Protection", 
    "Foreign Body", "Hazardous Substances", "Health/Medical/Disease", "Housekeeping", "Lifting and Rigging",
    "Lockout/Tagout, Danger Tag/Isolation", "Manual Handling", "Mobile Equipment", "Motor Vehicle", 
    "Noise", "Over/Near Water", "Permit to Work", "Personal Protective Equipment", "Procedure Breach", 
    "Quality Assurance/Quality Control", "Security", "Sharp Objects", "Signage", "Stacking Storage", 
    "Sustainability", "Thermal Stress (Hot / Cold)", "Travel", "Unguarded Equipment", "Weather Conditions",
    "Wildlife", "Work at Heights", "Workstation Ergonomics",
].sort();

// Voice input: records the microphone, encodes 16 kHz mono WAV and has Gemini transcribe it.
// Mimics the small part of the SpeechRecognition interface that App uses.
class GeminiRecognizer {
  static onStatus: (m: string) => void = () => {};
  continuous = false;
  interimResults = false;
  lang = "en-US";
  onresult: (e: any) => void = () => {};
  onerror: (e: any) => void = () => {};
  onend: () => void = () => {};
  onsoundstart?: () => void;
  onsoundend?: () => void;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private active = false;
  private startedAt = 0;
  private gen = 0;

  async start() {
    if (this.active) return;
    this.active = true;
    this.chunks = [];
    const my = ++this.gen;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e: any) {
      if (my !== this.gen) return;
      this.active = false;
      this.onerror({ error: e && e.name === "NotFoundError" ? "audio-capture" : "not-allowed" });
      this.onend();
      return;
    }
    if (!this.active || my !== this.gen) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    this.stream = stream;
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    const ctx: AudioContext = new AC();
    this.ctx = ctx;
    try { await ctx.resume(); } catch (_) { /* ignore */ }
    if (!this.active || my !== this.gen) return;
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (ev: AudioProcessingEvent) => {
      if (this.active) this.chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
    };
    src.connect(node);
    node.connect(ctx.destination);
    this.node = node;
    this.startedAt = Date.now();
    GeminiRecognizer.onStatus("Listening... click the microphone again when you are done speaking.");
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    const chunks = this.chunks;
    const rate = this.ctx ? this.ctx.sampleRate : 48000;
    const hadAudio = !!this.ctx && Date.now() - this.startedAt > 400 && chunks.length > 0;
    this.cleanup();
    this.chunks = [];
    if (!hadAudio) { this.onend(); return; }
    void this.transcribe(chunks, rate, this.gen);
  }

  abort() {
    this.active = false;
    this.gen++;
    this.chunks = [];
    this.cleanup();
    this.onend();
  }

  private cleanup() {
    try { if (this.node) { this.node.onaudioprocess = null; this.node.disconnect(); } } catch (_) { /* ignore */ }
    try { if (this.stream) this.stream.getTracks().forEach(t => t.stop()); } catch (_) { /* ignore */ }
    try { if (this.ctx) void this.ctx.close(); } catch (_) { /* ignore */ }
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }

  private async transcribe(chunks: Float32Array[], rate: number, my: number) {
    try {
      const wav = GeminiRecognizer.encodeWav(chunks, rate);
      GeminiRecognizer.onStatus("Transcribing...");
      const text = await invoke<string>("transcribe_audio", { audioBase64: wav, mimeType: "audio/wav" });
      if (my !== this.gen) return;
      const t = (text || "").trim();
      if (t) {
        this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] });
        GeminiRecognizer.onStatus("");
      } else {
        GeminiRecognizer.onStatus("No speech detected. Please try again.");
      }
    } catch (e: any) {
      if (my !== this.gen) return;
      this.onerror({ error: "transcribe: " + String(e).slice(0, 120) });
    } finally {
      if (my === this.gen) this.onend();
    }
  }

  private static encodeWav(chunks: Float32Array[], inRate: number): string {
    let len = 0;
    for (const c of chunks) len += c.length;
    const all = new Float32Array(len);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    const outRate = 16000;
    const ratio = inRate / outRate;
    const outLen = Math.floor(all.length / ratio);
    const buf = new ArrayBuffer(44 + outLen * 2);
    const v = new DataView(buf);
    const w = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + outLen * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, outRate, true); v.setUint32(28, outRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, outLen * 2, true);
    for (let i = 0; i < outLen; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(all.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let n = 0;
      for (let j = a; j < b; j++) { sum += all[j]; n++; }
      const s = Math.max(-1, Math.min(1, n ? sum / n : 0));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)) as any);
    }
    return btoa(bin);
  }
}

export default function App() {
  // Messages go where the user is looking, not to one line at the bottom:
  //   toasts          - pop-up notices at the top of the window (submission results, connection failures)
  //   submitProgress  - live progress text on the Submit button
  //   connectionDetail - tooltip on the header's connection status icon
  //   chatNote        - short note inside the chat (voice and AI problems)
  //   appWarning      - lasting warning strip under the header bar (project list problems)
  //   showFieldErrors - outlines missing form fields after a Submit attempt
  type Tone = "success" | "error" | "info";
  type Toast = { id: number; tone: Tone; message: string; action?: { label: string; run: () => void }; sticky?: boolean };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const dismissToast = (id: number) => setToasts(ts => ts.filter(t => t.id !== id));
  const notify = (tone: Tone, message: string, opts: { action?: Toast["action"]; sticky?: boolean } = {}) => {
    const id = ++toastIdRef.current;
    const sticky = opts.sticky ?? tone === "error";
    setToasts(ts => [...ts.slice(-2), { id, tone, message, action: opts.action, sticky }]);
    if (!sticky) window.setTimeout(() => dismissToast(id), 4500);
  };
  // Submission results come back as plain text; pick the tone from the wording.
  const toneOf = (msg: string): Tone => /error|fail|could not|cannot|unable|not available/i.test(msg) ? "error" : /success|submitted|connected/i.test(msg) ? "success" : "info";
  const [submitProgress, setSubmitProgress] = useState("");
  const [connectionDetail, setConnectionDetail] = useState("");
  const [chatNote, setChatNote] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [appWarning, setAppWarning] = useState("");
  const [showFieldErrors, setShowFieldErrors] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recognition, setRecognition] = useState<SpeechRecognition | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Chat State
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadingDots, setLoadingDots] = useState("");
  const [isApiKeyValid, setIsApiKeyValid] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
    const [startupConnectDone, setStartupConnectDone] = useState(false);
    const [startupTimedOut, setStartupTimedOut] = useState(false);
    useEffect(() => {
      const id = window.setTimeout(() => setStartupTimedOut(true), 15000);
      return () => window.clearTimeout(id);
    }, []);
    const startupReady = startupTimedOut || (!isInitialLoading && startupConnectDone);

  const handleNewChat = () => {
    setMessages([]);
    setChatInput("");
    setHighlightedFields(new Set());
    // Reset form fields to defaults
    setDetails("");
    setAction("");
    setCategory("");
    setExactLoc("");
    
    // Set date to today
    const today = new Date();
    setDate(today.toISOString().split("T")[0]);
    
    // Set time to now
    const now = new Date();
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    setTime(nowTime);
  };

  const [showKeyModal, setShowKeyModal] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // API Key State
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    const initKey = async () => {
      const startTime = Date.now();
      
      // Check if we are running inside Tauri
      const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI_IPC__;
      
      if (isTauri) {
        try {
          const savedKey = await invoke<string | null>("get_cached_key");
          if (savedKey) {
            setApiKey(savedKey);
            // Auto validate
            const result = "validated"; // validated when it was saved; a revoked key is caught on the first chat message
            if (result.includes("validated")) {
              setIsApiKeyValid(true);
              setApiKey("");
            }
          }
        } catch (e) {
          console.error("Failed to load cached key", e);
        }
      }
      
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, 150 - elapsed);
      setTimeout(() => setIsInitialLoading(false), remaining);
    };
    initKey();
  }, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isAiLoading) {
      interval = setInterval(() => {
        setLoadingDots(prev => (prev.length >= 3 ? "" : prev + "."));
      }, 500);
    } else {
      setLoadingDots("");
    }
    return () => clearInterval(interval);
  }, [isAiLoading]);

  useEffect(() => {
    const unlisten = listen("api-key-cleared", () => {
      setIsApiKeyValid(false);
      setApiKey("");
      notify("info", "API key cleared.");
    });
    return () => {
      unlisten.then(f => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("activation-debug", (event) => {
      setConnectionDetail(event.payload);
      console.log("Activation debug:", event.payload);
    });
    const unlistenProgress = listen<string>("submission-progress", (event) => {
      setSubmitProgress(event.payload);
      console.log("Submission progress:", event.payload);
    });

    return () => {
      unlisten.then(f => f());
      unlistenProgress.then(f => f());
    };
  }, []);

  // Reads the activation_success.marker file written by activate_handshake
  // and exposes its age in hours. Called on app launch and after each connect.
  const refreshActivationAge = async () => {
    try {
      const hours = await invoke<number | null>("get_activation_age_hours");
      setActivationAgeHours(hours);
    } catch (e) {
      console.warn("Could not read activation age:", e);
      setActivationAgeHours(null);
    }
  };

  useEffect(() => {
    refreshActivationAge();
  }, []);

  // On app launch: if the user has previously activated successfully (marker
  // file exists), do a lightweight ping to confirm the ROAM server is still
  // reachable, and show "Connected" automatically. No browser is opened.
  // Only first-time users and users whose NTLM cache was wiped see the
  // explicit Connect button as an interactive action.
  const autoConnectOnLaunch = async () => {
    try {
      const hasMarker = await invoke<boolean>("has_activation_marker");
      if (!hasMarker) {
        setConnectionDetail("Not connected - click to connect to ROAM");
        notify("info", "First-time setup: connect to ROAM to enable submissions.", { sticky: true, action: { label: "Connect", run: () => handleActivate() } });
        return;
      }
      setIsActivating(true);
      setConnectionDetail("Checking ROAM connection...");
      try {
        await invoke<boolean>("ping_roam");
        setIsActivated(true);
        setActivationError(false);
        localStorage.setItem("roam_activated", "true");
        setConnectionDetail("Connected to ROAM");
      } catch (e) {
        setActivationError(true);
        setIsActivated(false);
        localStorage.removeItem("roam_activated");
        setConnectionDetail(`Connection check failed: ${e}`);
        notify("error", `Could not connect to ROAM: ${e}`, { action: { label: "Try again", run: () => handleActivate() } });
      } finally {
        setIsActivating(false);
      }
    } catch (e) {
      console.warn("autoConnectOnLaunch error:", e);
    }
  };

  useEffect(() => {
    autoConnectOnLaunch().finally(() => setStartupConnectDone(true));
  }, []);

  // === WARMUP-RELATED STATE - MUST BE DECLARED BEFORE THE WARMUP USEEFFECT BELOW ===
  // React's rules of hooks require these state variables to be in lexical scope
  // before any useEffect that references them in its dependency array. Moving
  // these declarations below the useEffect (or removing them) will crash the
  // app at runtime with "Cannot access 'X' before initialization".
  //
  // The list-related state lives here too because the warmup useEffect's
  // dependency array references projectsList.length to gate warmup until
  // SharePoint data has loaded (both processes use the same edge_profile
  // folder and cannot run simultaneously).
  const [warmupState, setWarmupState] = useState<WarmupState | null>("loading");
  const [warmupAttempt, setWarmupAttempt] = useState<number>(1);
  const [networkRetrySeconds, setNetworkRetrySeconds] = useState<number | null>(null);
  const [warmupRetryNonce, setWarmupRetryNonce] = useState<number>(0);
    const [warmupFailureDetail, setWarmupFailureDetail] = useState<string>("");
  const [projectsList, setProjectsList] = useState<string[]>(PROJECTS_LIST_DEFAULT);
  const [citiesList, setCitiesList] = useState<string[]>(CITIES_LIST_DEFAULT);
  const [streetsList, setStreetsList] = useState<string[]>(STREETS_LIST_DEFAULT);
  const [dataAgeDays, setDataAgeDays] = useState<number | null>(null);
  const [dataFromCache, setDataFromCache] = useState<boolean>(false);

  // First-launch warmup orchestrator.
  // Runs ONCE per app version. Reads the marker file via Rust; if warmup is
  // not needed (we've already warmed up this version), immediately hides the
  // overlay. Otherwise runs warmup_submission with up to 3 attempts, with
  // network re-checks in between using exponential backoff (30s, 60s, 2m, 4m,
  // 8m cap) if the user is offline.
  useEffect(() => {
    let cancelled = false;
    const MAX_ATTEMPTS = 3;
    const BACKOFF_STEPS_SECONDS = [30, 60, 120, 240, 480];

    const sleep = (ms: number) => new Promise<void>(resolve => {
      const id = window.setTimeout(resolve, ms);
      (sleep as any)._id = id;
    });

    async function networkCountdown(seconds: number) {
      // Live countdown that updates the overlay's "Checking again in X seconds..."
      for (let s = seconds; s > 0 && !cancelled; s--) {
        setNetworkRetrySeconds(s);
        await sleep(1000);
      }
      setNetworkRetrySeconds(null);
    }

    async function waitForNetwork() {
      let stepIndex = 0;
      while (!cancelled) {
        try {
          const reachable = await invoke<boolean>("warmup_check_network");
          if (reachable) return true;
        } catch (e) {
          console.warn("warmup_check_network failed:", e);
        }
        // Still offline. Show network_error state and wait with countdown.
        if (cancelled) return false;
        setWarmupState("network_error");
        const wait = BACKOFF_STEPS_SECONDS[Math.min(stepIndex, BACKOFF_STEPS_SECONDS.length - 1)];
        await networkCountdown(wait);
        stepIndex++;
      }
      return false;
    }

    async function runWarmup() {
      // Check if warmup is needed at all
      try {
        const needed = await invoke<boolean>("is_warmup_needed");
        if (!needed) {
          // Warmup not needed. Don't show the overlay at all.
          if (!cancelled) setWarmupState(null);
          return;
        }
        // Warmup is genuinely needed - show the overlay now.
        if (!cancelled) setWarmupState("loading");
      } catch (e) {
        // If we can't even check, assume not needed and let the readiness
        // useEffect decide when to hide the overlay.
        console.warn("is_warmup_needed failed, skipping warmup:", e);
        return;
      }

      // Fast network pre-check: if ROAM is unreachable right now, jump straight
      // to the network_error overlay instead of leaving the user looking at the
      // "Configuring..." spinner for tens of seconds while individual operations
      // time out one by one. waitForNetwork() handles the overlay state and the
      // exponential-backoff retry loop internally.
      setWarmupAttempt(1);
      try {
        const reachableImmediately = await invoke<boolean>("warmup_check_network");
        if (!reachableImmediately) {
          const online = await waitForNetwork();
          if (!online || cancelled) return;
        }
      } catch (e) {
        // If the network check itself errors, fall through to waitForNetwork
        // which will handle it gracefully.
        console.warn("Pre-flight network check threw, falling back:", e);
        const online = await waitForNetwork();
        if (!online || cancelled) return;
      }
      setWarmupState("loading");

      // Attempt loop. Try headless first; if SSO redirect detected, fall back
      // to visible mode so the user can sign in.
      let safetyGuardTripped = false;
      let needsVisible = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cancelled; attempt++) {
        setWarmupAttempt(attempt);
        setWarmupState(needsVisible || attempt === MAX_ATTEMPTS ? "sso_needed" : "loading");
        try {
          const result = await invoke<string>("warmup_submission", {
            visible: needsVisible || attempt === MAX_ATTEMPTS,
          });
          if (cancelled) return;
          // Any Ok result means warmup succeeded
          if (result === "warmed" || result.length > 0) {
            try {
              await invoke("mark_warmup_complete", {
                attempts: attempt,
                safetyGuardTripped,
              });
            } catch (e) {
              console.warn("mark_warmup_complete failed:", e);
            }
            // Warmup itself succeeded. Transition the overlay through the
            // success state and then dismiss it. We must trigger this here
            // because the readiness useEffect only re-fires when its
            // dependencies change, and neither of them changes when the
            // marker file is written by Rust.
            if (!cancelled) {
              setWarmupState("success");
              await new Promise<void>(resolve => window.setTimeout(resolve, 1200));
              if (!cancelled) setWarmupState(null);
            }
            return;
          }
        } catch (e) {
          const errStr = String(e);
          console.warn(`warmup attempt ${attempt} failed:`, errStr);
          setWarmupFailureDetail(`Attempt ${attempt} of ${MAX_ATTEMPTS}: ${errStr}`);
          invoke("append_warmup_log", { line: `attempt ${attempt}/${MAX_ATTEMPTS} visible=${needsVisible || attempt === MAX_ATTEMPTS}: ${errStr}` }).catch(() => {});
          // SSO redirect detected by the Rust side. Re-run this same attempt
          // with visible mode so the user can sign in. Do not increment the
          // attempt counter - the visible run replaces the headless one.
          if (errStr.includes("sso_redirect_needs_visible")) {
            needsVisible = true;
            attempt--; // retry same attempt number with visible mode
            continue;
          }
          // Check for the developer-attention safety guard
          if (errStr.includes("guard_tripped")) {
            safetyGuardTripped = true;
            // Don't retry if guard tripped - ROAM may be accepting our bad value
            setWarmupState("failure");
            return;
          }
          // Check if we lost network during the attempt
          try {
            const reachable = await invoke<boolean>("warmup_check_network");
            if (!reachable && !cancelled) {
              const back = await waitForNetwork();
              if (!back || cancelled) return;
              // Retry the same attempt number since this one was network-failed
              attempt--;
              continue;
            }
          } catch (_) { /* ignore */ }
        }
      }

      // All MAX_ATTEMPTS exhausted
      if (!cancelled) setWarmupState("failure");
    }

    // Wait for fetch_project_data to finish populating projectsList before
    // we kick off the warmup. Both processes use the same edge_profile folder
    // so they cannot run simultaneously - we get DevTools port contention.
    if (projectsList.length === 0) {
      return; // useEffect will re-fire when projectsList grows
    }

    runWarmup();

    return () => {
      cancelled = true;
      // Cancel any in-flight sleep timer
      const pendingTimer = (sleep as any)._id;
      if (pendingTimer) window.clearTimeout(pendingTimer);
    };
  }, [warmupRetryNonce, projectsList.length]);


  // Auto-update check on app launch. Silent on failure - if GitHub is
  // unreachable or there is no update available, the user sees nothing
  // and uses the app normally. If an update IS available, the .msi is
  // downloaded, signature-verified against the embedded public key,
  // installed, and the app relaunches itself on the new version.
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);

  // First-launch warmup state. While this is non-null, the WarmupOverlay
  // covers the entire app and the main UI is hidden. The warmup useEffect
  // The downloaded-but-not-installed Update object. When set, the "?" button
  // shows a red dot and an install button appears in the dropdown.
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);

  const handleInstallUpdate = async () => {
    if (!pendingUpdate) return;
    if (isSubmitting) {
      notify("info", "Finish the current submission before installing the update.");
      setShowVersion(false);
      return;
    }
    setIsInstallingUpdate(true);
    notify("info", `Installing update v${pendingUpdate.version}...`, { sticky: true });
    try {
      await pendingUpdate.install();
      await relaunch();
    } catch (e) {
      console.error("Update install failed:", e);
      notify("error", `Update install failed: ${e}`);
      setIsInstallingUpdate(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        let cached: ProjectDataResult | null = null;
          try { cached = await invoke<ProjectDataResult | null>("get_cached_project_data"); } catch (_) { cached = null; }
          const fastPath = !!(cached && cached.data && cached.data.projects && cached.data.projects.length > 0) && (cached!.ageDays ?? 999) <= 7;
          if (fastPath && cached) {
            setProjectsList(cached.data.projects);
            setCitiesList(cached.data.cities);
            setStreetsList(cached.data.streets);
            setDataAgeDays(cached.ageDays);
            setDataFromCache(true);
          }
          const result = await invoke<ProjectDataResult>("fetch_project_data", { background: fastPath });
        if (result?.data?.projects) {
          setProjectsList(result.data.projects);
          setCitiesList(result.data.cities);
          setStreetsList(result.data.streets);
          setDataAgeDays(result.ageDays);
          setDataFromCache(result.fromCache);
          if (result.fromCache && (result.ageDays ?? 0) > 7) {
            setAppWarning(`Project list last updated ${Math.round(result.ageDays ?? 0)} days ago. Connect to a Hatch network to refresh.`);
          }
        } else {
          // Result came back malformed - degrade gracefully
          console.warn("Project data result was malformed:", result);
          setAppWarning("Project list unavailable. Some dropdowns will be empty until next launch.");
        }
      } catch (e) {
        // Fetch failed entirely (no network, no cache, SharePoint auth, etc).
        // The UI still renders - dropdowns will be empty but the rest works.
        console.warn("Project data load failed:", e);
        setAppWarning(`Project list unavailable: ${e}. Dropdowns will be empty - the rest of the app still works.`);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const update = await check();
        if (!update) return;
        // Quietly download in the background. Install is triggered by the
        // user via the "?" menu so they choose when to interrupt their work.
        let downloaded = 0;
        let total = 0;
        await update.download((event) => {
          if (event.event === "Started") {
            total = event.data.contentLength ?? 0;
            setUpdateProgress(0);
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            if (total > 0) {
              const pct = Math.round((downloaded / total) * 100);
              setUpdateProgress(pct);
            }
          } else if (event.event === "Finished") {
            setUpdateProgress(null);
          }
        });
        setPendingUpdate(update);
      } catch (e) {
        console.warn("Update check failed (will retry next launch):", e);
        // Silent failure - do not block the user from using the app
      }
    })();
  }, []);

  // Form State
  const [project, setProject] = useState(() => localStorage.getItem("roam_project") || "Hatch Global (Project View)");
  const [office, setOffice] = useState(() => localStorage.getItem("roam_office") || "Johannesburg");
  const [address, setAddress] = useState(() => localStorage.getItem("roam_address") || "58 Emerald Parkway Road, Greenstone Hill");
  const [exactLoc, setExactLoc] = useState("office");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  
  const [isContractor, setIsContractor] = useState(false);
  const [isWorkHours, setIsWorkHours] = useState(false);
  const [obsType, setObsType] = useState("Behaviour");
  const [obsSafe, setObsSafe] = useState("Safe");
  const [officeLoc, setOfficeLoc] = useState("Hatch office");
  
  const [details, setDetails] = useState("");
  const [action, setAction] = useState("");
  const [category, setCategory] = useState(""); 
  const [cardType, setCardType] = useState("Field");

  const [highlightedFields, setHighlightedFields] = useState<Set<string>>(new Set());

  const [isProjectLocked, setIsProjectLocked] = useState(false);
  const [isOfficeLocked, setIsOfficeLocked] = useState(false);
  const [isAddressLocked, setIsAddressLocked] = useState(false);

  const [showDebugMenu, setShowDebugMenu] = useState(false);
  const [isDebugVisible, setIsDebugVisible] = useState(false);
  const [isActivated, setIsActivated] = useState(() => localStorage.getItem("roam_activated") === "true");
  const [isActivating, setIsActivating] = useState(false);
  const [showVersion, setShowVersion] = useState(false);
  const [showSubmitTooltip, setShowSubmitTooltip] = useState(false);
  const [activationError, setActivationError] = useState(false);
  const [activationAgeHours, setActivationAgeHours] = useState<number | null>(null);
  // Persist project, office, and address to localStorage
  useEffect(() => {
    localStorage.setItem("roam_project", project);
  }, [project]);

  useEffect(() => {
    localStorage.setItem("roam_office", office);
  }, [office]);

  useEffect(() => {
    localStorage.setItem("roam_address", address);
  }, [address]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.altKey && e.key.toLowerCase() === 'd') {
        setShowDebugMenu(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Colour theme: the user's choice (light, dark or follow the system),
  // remembered between launches. isDark is what the rest of the app reads.
  type ThemePref = "system" | "light" | "dark";
  const [themePref, setThemePref] = useState<ThemePref>(() => {
    try {
      const saved = localStorage.getItem("roam_theme");
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch { return "system"; }
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  const isDark = themePref === "system" ? systemDark : themePref === "dark";
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { localStorage.setItem("roam_theme", themePref); } catch { /* storage unavailable */ }
    // Match the native title bar to the chosen theme (null = follow the system).
    getCurrentWindow().setTheme(themePref === "system" ? null : themePref).catch(e => console.warn("setTheme failed:", e));
  }, [themePref]);
  useEffect(() => {
    if (!showThemeMenu) return;
    const onDown = (e: MouseEvent) => { if (themeMenuRef.current && !themeMenuRef.current.contains(e.target as Node)) setShowThemeMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowThemeMenu(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [showThemeMenu]);

  // Monthly observation tracker (sidebar). Real counts come from the Power BI
  // report (see src-tauri/src/powerbi.rs); until the report is configured the
  // sidebar shows sample data with a Shuffle button.
  const trackerNow = new Date();
  const trackerYear = trackerNow.getFullYear();
  const [monthlyCounts, setMonthlyCounts] = useState(() => generateRandomMonthlyCounts(trackerYear));
  const [obsData, setObsData] = useState<ObservationCounts | null>(null);
  const [obsLoading, setObsLoading] = useState(false);
  const [obsError, setObsError] = useState("");
  // False only when the report is not set up in tauri.conf.json (sample data mode).
  const [obsConfigured, setObsConfigured] = useState(true);
  // The user's own name in the report, detected from their Microsoft or
  // Windows sign-in (never typed in). Remembered so later checks can open
  // the report filtered straight to them.
  const [observerName, setObserverName] = useState(() => {
    try { return localStorage.getItem("roam_observer") || ""; } catch { return ""; }
  });
  const saveObserver = (name: string) => {
    setObserverName(name);
    try { localStorage.setItem("roam_observer", name); } catch { /* storage unavailable */ }
  };
  // Observations submitted from this computer that the official counts may
  // not include yet (they are refreshed on a schedule). Shown on top of the
  // official counts until a later check includes them.
  const [localObs, setLocalObs] = useState<LocalObservation[]>(() => {
    try { return JSON.parse(localStorage.getItem("roam_local_obs") || "[]"); } catch { return []; }
  });
  const updateLocalObs = (change: (list: LocalObservation[]) => LocalObservation[]) => {
    setLocalObs(prev => {
      const next = change(prev);
      try { localStorage.setItem("roam_local_obs", JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  };
  const recordSubmission = (status: LocalObservation["status"], observationDate: string) => {
    const month = /^\d{4}-\d{2}/.test(observationDate) ? observationDate.slice(0, 7) : new Date().toISOString().slice(0, 7);
    const baseline = obsDataRef.current?.observers[observerName]?.[month] ?? 0;
    const entry: LocalObservation = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, month, status, at: new Date().toISOString(), baseline };
    updateLocalObs(list => [...list, entry]);
  };

  // Latest counts, for spotting changes after a background check.
  const obsDataRef = useRef<ObservationCounts | null>(null);
  const showObsData = (data: ObservationCounts) => { obsDataRef.current = data; setObsData(data); };
  // The report is optional: a missing config means "stay on sample data", not an error.
  const isNotConfigured = (msg: string) => /observationReport/.test(msg);
  const loadObservationCounts = async (interactive: boolean, observer: string = observerName) => {
    setObsLoading(true);
    const before = obsDataRef.current;
    try {
      const fresh = await invoke<ObservationCounts>("fetch_observation_counts", { interactive, observer: observer || null, save: true });
      const name = fresh.observer || observer;
      if (fresh.observer && fresh.observer !== observerName) saveObserver(fresh.observer);
      showObsData(fresh);
      if (name && fresh.observers[name]) updateLocalObs(list => reconcileLocal(list, fresh.observers[name]));
      setObsError("");
      setObsConfigured(true);
      const changed = !!before && !!name && before.observers[name] !== undefined
        && countsForObserver(before, name, trackerYear).join() !== countsForObserver(fresh, name, trackerYear).join();
      if (interactive) notify("success", "Observation counts updated.");
      else if (changed) notify("info", "Your observation counts have been updated.");
    } catch (e) {
      const msg = `${e}`;
      if (isNotConfigured(msg)) {
        setObsError("");
        setObsConfigured(false);
        if (interactive) notify("info", "Observation counts are not set up yet.");
      } else if (observer && /^No rows for/.test(msg)) {
        // The remembered name no longer matches: detect the user again.
        saveObserver("");
        setObsLoading(false);
        return loadObservationCounts(interactive, "");
      } else {
        setObsError(msg);
        if (interactive) notify("error", `Could not update observation counts: ${msg}`, { action: { label: "Try again", run: () => loadObservationCounts(true) } });
      }
    } finally {
      setObsLoading(false);
    }
  };

  // Looking up a colleague: shows their counts in the sidebar without
  // changing who the user is or their saved counts.
  const [showLookup, setShowLookup] = useState(false);
  const [viewing, setViewing] = useState<{ name: string; data: ObservationCounts | null; loading: boolean; error: string } | null>(null);
  const viewPerson = async (name: string) => {
    setShowLookup(false);
    if (name === observerName) { setViewing(null); return; }
    setViewing({ name, data: null, loading: true, error: "" });
    try {
      const data = await invoke<ObservationCounts>("fetch_observation_counts", { interactive: false, observer: name, save: false });
      setViewing(v => (v && v.name === name ? { ...v, data, loading: false } : v));
    } catch (e) {
      setViewing(v => (v && v.name === name ? { ...v, loading: false, error: `${e}` } : v));
    }
  };
  // "My crew": colleagues the user competes with, kept on this computer, and
  // their monthly counts (read by exact name from the official data).
  const [crew, setCrew] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("roam_crew") || "[]"); } catch { return []; }
  });
  const [crewData, setCrewData] = useState<{ observers: Record<string, Record<string, number>>; emails?: Record<string, string>; fetchedAt: string } | null>(() => {
    try { return JSON.parse(localStorage.getItem("roam_crew_data") || "null"); } catch { return null; }
  });
  const [crewLoading, setCrewLoading] = useState(false);
  const [crewError, setCrewError] = useState("");
  const [crewProgress, setCrewProgress] = useState("");
  const [showCrew, setShowCrew] = useState(false);
  const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const saveCrew = (list: string[]) => {
    setCrew(list);
    try { localStorage.setItem("roam_crew", JSON.stringify(list)); } catch { /* storage unavailable */ }
  };
  const mergeCrewData = (observers: Record<string, Record<string, number>>, fetchedAt: string, emails: Record<string, string> = {}) => {
    setCrewData(prev => {
      const next = { observers: { ...(prev?.observers ?? {}), ...observers }, emails: { ...(prev?.emails ?? {}), ...emails }, fetchedAt };
      try { localStorage.setItem("roam_crew_data", JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  };
  const loadCrew = async (names: string[], interactive: boolean) => {
    if (names.length === 0) return;
    setCrewLoading(true);
    setCrewError("");
    try {
      const r = await invoke<PasteResult>("fetch_people", { names, interactive });
      mergeCrewData(r.observers, r.fetchedAt, r.emails);
    } catch (e) {
      setCrewError(`${e}`);
    } finally {
      setCrewLoading(false);
    }
  };
  const addToCrew = (names: string[], known?: PasteResult) => {
    const added = names.filter(n => !sameName(n, observerName) && !crew.some(c => sameName(c, n)));
    if (added.length === 0) return;
    saveCrew([...crew, ...added]);
    if (known) mergeCrewData(Object.fromEntries(added.filter(n => known.observers[n]).map(n => [n, known.observers[n]])), known.fetchedAt, known.emails);
    const missing = added.filter(n => !known?.observers[n] && !crewData?.observers[n]);
    loadCrew(missing, false);
    notify("success", added.length === 1 ? `${displayName(added[0])} added to your crew.` : `${added.length} people added to your crew.`);
  };
  const removeFromCrew = (name: string) => saveCrew(crew.filter(c => !sameName(c, name)));

  // Nudges: a short Teams message to a crew member below target this month.
  // Teams opens with the message typed in; the user presses Send.
  const [nudges, setNudges] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("roam_nudges") || "{}"); } catch { return {}; }
  });
  const nudgedRecently = (name: string) => {
    const at = nudges[name];
    return !!at && (Date.now() - new Date(at).getTime()) / 86400000 < NUDGE_COOLDOWN_DAYS;
  };
  const nudge = async (name: string, count: number) => {
    const message = nudgeMessage(name, count, new Date());
    const email = crewData?.emails?.[name];
    if (!email) {
      // Older crew data has no emails: copy the message and fetch them.
      navigator.clipboard?.writeText(message).catch(() => { /* clipboard unavailable */ });
      notify("info", `${displayName(name)}'s Teams address isn't loaded yet. The message is copied: paste it in a Teams chat, or try again in a minute.`);
      if (!crewLoading) loadCrew([name], false);
      return;
    }
    try {
      await invoke("open_teams_chat", { email, message });
    } catch (e) {
      notify("error", `Could not open Teams: ${e}`);
      return;
    }
    const next = { ...nudges, [name]: new Date().toISOString() };
    setNudges(next);
    try { localStorage.setItem("roam_nudges", JSON.stringify(next)); } catch { /* storage unavailable */ }
    notify("success", `Teams opened with a nudge for ${displayName(name)}. Press Send in Teams.`);
  };
  useEffect(() => {
    const unlisten = listen<string>("people-progress", e => setCrewProgress(e.payload));
    return () => { unlisten.then(f => f()); };
  }, []);

  // Leaderboard of the user's reporting location or discipline (official data).
  const [boards, setBoards] = useState<Record<string, Leaderboard>>({});
  const [boardScope, setBoardScope] = useState(() => {
    try { return localStorage.getItem("roam_board_scope") || "location"; } catch { return "location"; }
  });
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState("");
  const loadBoard = async (scope: string, interactive: boolean) => {
    setBoardLoading(true);
    setBoardError("");
    try {
      const fresh = await invoke<Leaderboard>("fetch_leaderboard", { scope, interactive });
      setBoards(b => ({ ...b, [scope]: fresh }));
    } catch (e) {
      // "Not known yet" just means the user's own counts (which carry their
      // location and discipline) have not loaded: a wait, not an error.
      const msg = `${e}`;
      setBoardError(/not known yet/i.test(msg) ? "" : msg);
    } finally {
      setBoardLoading(false);
    }
  };
  // A location/discipline leaderboard needs the user's own group, which
  // arrives with their own counts. The crew needs nothing.
  const groupKnown = (scope: string) => scope === "crew" || !!obsDataRef.current?.groups?.[scope];
  const boardOpenedRef = useRef(false);
  // Shows the saved leaderboard straight away; refreshes it when it is
  // missing or more than 6 hours old.
  const openBoard = async (scope: string) => {
    boardOpenedRef.current = true;
    if (scope === "crew") {
      const stale = !crewData || (Date.now() - new Date(crewData.fetchedAt).getTime()) / 3600000 > 6;
      const missing = crew.filter(n => !crewData?.observers[n]);
      if (!crewLoading && crew.length && (stale || missing.length)) loadCrew(stale ? crew : missing, false);
      return;
    }
    let current: Leaderboard | null = boards[scope] ?? null;
    if (!current) {
      try { current = await invoke<Leaderboard | null>("get_cached_leaderboard", { scope }); } catch { current = null; }
      if (current) setBoards(b => ({ ...b, [scope]: current! }));
    }
    const ageHours = current ? (Date.now() - new Date(current.fetchedAt).getTime()) / 3600000 : Infinity;
    if (!boardLoading && ageHours > 6 && groupKnown(scope)) loadBoard(scope, false);
  };
  const chooseBoardScope = (scope: string) => {
    setBoardScope(scope);
    setBoardError("");
    try { localStorage.setItem("roam_board_scope", scope); } catch { /* storage unavailable */ }
    openBoard(scope);
  };

  const [inspectResult, setInspectResult] = useState<string | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const handleInspectReport = async () => {
    setIsInspecting(true);
    notify("info", "Opening the observation report. Sign in if asked; the window closes by itself.");
    try {
      const summary = await invoke<unknown>("inspect_powerbi_report", { observer: observerName || null });
      setInspectResult(JSON.stringify(summary, null, 2));
    } catch (e) {
      notify("error", `Could not inspect the report: ${e}`);
    } finally {
      setIsInspecting(false);
    }
  };
  const obsHasData = !!obsData && !!observerName && !!obsData.observers[observerName];
  const viewingHasData = !!viewing?.data && !!viewing.data.observers[viewing.name];
  const localAdj = localAdjustments(localObs, trackerYear);
  const showLocal = obsConfigured && !viewing;
  const sidebarCounts = !obsConfigured ? monthlyCounts
    : viewing ? (viewingHasData ? countsForObserver(viewing.data!, viewing.name, trackerYear) : Array(12).fill(0))
    : (obsHasData ? countsForObserver(obsData!, observerName, trackerYear) : Array(12).fill(0)).map((n, i) => n + localAdj.extra[i]);
  const sidebarPending = showLocal ? localAdj.pending : undefined;
  const monthIndex = trackerNow.getMonth();
  const monthKey = `${trackerYear}-${String(monthIndex + 1).padStart(2, "0")}`;
  const me = observerName && obsData?.observers[observerName] ? { [observerName]: obsData.observers[observerName] } : {};
  // Share the crew: names one per line, ready to paste in "Add from a list".
  const copyCrew = () => {
    const text = [...crew].map(displayName).sort((a, b) => a.localeCompare(b)).join("\n");
    navigator.clipboard.writeText(text).then(
      () => notify("success", `${crew.length} name${crew.length === 1 ? "" : "s"} copied. Others can paste them in My crew > Add from a list.`),
      () => notify("error", "Could not copy the names."),
    );
  };
  // This year so far, one row per person (crew and you), alphabetical.
  const exportCrew = async () => {
    const months = Array.from({ length: monthIndex + 1 }, (_, m) => new Date(trackerYear, m, 1).toLocaleString("en", { month: "short" }));
    const rowFor = (name: string, data: Record<string, number>, extra: number[] = []) => ({
      name: displayName(name),
      counts: months.map((_, m) => Math.round(data[`${trackerYear}-${String(m + 1).padStart(2, "0")}`] ?? 0) + (extra[m] ?? 0)),
    });
    const rows = [
      ...crew.filter(n => crewData?.observers[n]).map(n => rowFor(n, crewData!.observers[n])),
      ...(observerName && obsData?.observers[observerName] ? [rowFor(observerName, obsData.observers[observerName], localAdj.extra)] : []),
    ].sort((a, b) => a.name.localeCompare(b.name));
    if (rows.length === 0) { notify("error", "No crew counts loaded yet. Refresh the crew leaderboard first."); return; }
    const missing = crew.filter(n => !crewData?.observers[n]).length;
    try {
      const path = await save({ defaultPath: `ROAM crew observations ${trackerYear}.xlsx`, filters: [{ name: "Excel workbook", extensions: ["xlsx"] }] });
      if (!path) return;
      await invoke("export_crew_xlsx", { path, year: trackerYear, months, rows, target: MONTHLY_TARGET });
      notify("success", `Exported ${rows.length} people.${missing ? ` ${missing} without loaded counts were left out.` : ""}`);
    } catch (e) {
      notify("error", `Could not export: ${e}`);
    }
  };
  const crewBoard: Leaderboard = {
    scope: "crew",
    group: "My crew",
    observers: { ...Object.fromEntries(crew.filter(n => crewData?.observers[n]).map(n => [n, crewData!.observers[n]])), ...me },
    fetchedAt: crewData?.fetchedAt ?? new Date().toISOString(),
    complete: true,
    fromCache: false,
    ageHours: null,
  };
  const onCrewBoard = boardScope === "crew";
  const activeBoard = onCrewBoard ? crewBoard : boards[boardScope];
  // The crew is small and the people worth nudging sit at the bottom, so it is listed in full.
  const ranking = activeBoard ? rankLeaderboard(activeBoard, monthKey, observerName, localAdj.extra[monthIndex], onCrewBoard ? Infinity : 10) : null;
  const groups = obsData?.groups ?? {};
  const boardWaitingFor = boardScope === "crew" || groups[boardScope] ? "" : boardScope === "location" ? "your reporting location" : "your discipline";

  const colors = isDark ? {
    bg: "#1A1A1A", surface: "#2A2A2A", border: "#4A4A4A", text: "#E0E0E0",
    text_muted: "#A0A0A0", primary: "#5B7A8C", primary_hover: "#6E8FA3",
    input_bg: "#2E2E2E", input_text: "#E0E0E0", warning: "#F0A04B", success: "#1A7F37",
    success_bg: "#1C3325", error_bg: "#3A1F1F",
    sage: "#2E3B2A",
    card_bg: "#242424", modal_bg: "#2E2E2E", modal_overlay: "rgba(0,0,0,0.7)",
    toggle_off: "#555555", locked_bg: "#3A3A3A", debug_bg: "#2E2800",
    debug_border: "#5A4800", debug_text: "#D4A800", error_red: "#FF6B6B"
  } : {
    bg: "#FAFAFA", surface: "#F0F0F0", border: "#BFBFBF", text: "#2E2E2E",
    text_muted: "#595959", primary: "#425563", primary_hover: "#2F3C46",
    input_bg: "#FFFFFF", input_text: "#2E2E2E", warning: "#BC5A00", success: "#1A7F37",
    success_bg: "#E6F4EA", error_bg: "#FDECEA",
    sage: "#E0EADD",
    card_bg: "#FFFFFF", modal_bg: "#FFFFFF", modal_overlay: "rgba(0,0,0,0.5)",
    toggle_off: "#8C8C8C", locked_bg: "#E0E0E0", debug_bg: "#FFFBE6",
    debug_border: "#FFE58F", debug_text: "#856404", error_red: "#CF222E"
  };

  // Initialize speech recognition
  useEffect(() => {
    const WindowSpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (WindowSpeechRecognition || navigator.mediaDevices?.getUserMedia) {
      GeminiRecognizer.onStatus = (m: string) => setChatNote(m ? { text: m, tone: /no speech|fail|could not/i.test(m) ? "error" : "info" } : null);
      const recognitionInstance = new GeminiRecognizer() as unknown as SpeechRecognition;
      recognitionInstance.continuous = true;
      recognitionInstance.interimResults = true;
      recognitionInstance.lang = 'en-US';

      recognitionInstance.onresult = (event: any) => {
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }
        
        setChatInput(prev => {
          // If we have new final results, append them. Otherwise just show current final + new interim.
          const currentFinal = Array.from(event.results)
            .filter((r: any) => r.isFinal)
            .map((r: any) => r[0].transcript)
            .join('');
          return currentFinal + interimTranscript;
        });
        
        // Auto-expand textarea for voice input
        const area = document.querySelector('textarea');
        if (area) {
          area.style.height = 'auto';
          area.style.height = area.scrollHeight + 'px';
        }

        // Reset silence timer to 3 seconds after the last input is received
        silenceTimerRef.current = setTimeout(() => {
          try { recognitionInstance.stop(); } catch(e) {}
        }, 3000);
      };

      recognitionInstance.onsoundstart = () => {
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      };

      recognitionInstance.onsoundend = () => {
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = setTimeout(() => {
          recognitionInstance.stop();
        }, 3000);
      };

      recognitionInstance.onerror = (event: any) => {
        console.error("Speech recognition error", event.error);
          if (event.error !== "no-speech" && event.error !== "aborted") {
            setChatNote({ text: `Voice input failed (${event.error}). Please type your observation instead.`, tone: "error" });
          }
        setIsRecording(false);
      };

      recognitionInstance.onend = () => {
        setIsRecording(false);
      };

      setRecognition(recognitionInstance);
    }
  }, []);

  const handleClearApiKey = async () => {
    try {
      await invoke("clear_api_key");
      setIsApiKeyValid(false);
      setApiKey("");
      notify("info", "API key cleared.");
    } catch (error) {
      notify("error", `Error clearing key: ${error}`);
    }
  };

  const handleSendFeedback = async () => {
    try {
      await invoke("send_feedback");
    } catch (error) {
      console.error("Failed to send feedback", error);
    }
  };

  // Clears earlier connect prompts and connection errors once connected.
  const dismissConnectToasts = () => setToasts(ts => ts.filter(t => t.action?.label !== "Connect" && t.action?.label !== "Try again"));

  const handleActivate = async () => {
    setIsActivating(true);
    setActivationError(false);
    try {
      // If the user has already activated once, the Connect button is just a
      // re-ping - fast, no browser window. If they have not, fall through to
      // the full visible interactive activation flow.
      const hasMarker = await invoke<boolean>("has_activation_marker");
      if (hasMarker) {
        setConnectionDetail("Checking ROAM connection...");
        await invoke<boolean>("ping_roam");
        setIsActivated(true);
        setActivationError(false);
        localStorage.setItem("roam_activated", "true");
        setConnectionDetail("Connected to ROAM");
        dismissConnectToasts();
        return;
      }
      setConnectionDetail("First-time setup: a browser window will open for authentication...");
      notify("info", "A browser window will open to sign in to ROAM.");
      await invoke("activate_handshake");
      setIsActivated(true);
      setActivationError(false);
      localStorage.setItem("roam_activated", "true");
      refreshActivationAge();
      setConnectionDetail("Connected to ROAM");
      dismissConnectToasts();
      notify("success", "Connected to ROAM.");
    } catch (error) {
      setActivationError(true);
      setIsActivated(false);
      localStorage.removeItem("roam_activated");
      setConnectionDetail(`Connection failed: ${error}`);
      notify("error", `Could not connect to ROAM: ${error}`, { action: { label: "Try again", run: () => handleActivate() } });
    } finally {
      setIsActivating(false);
    }
  };

  const handleSaveApiKey = async () => {
    const keyToValidate = apiKey.trim();
    if (!keyToValidate) {
      notify("error", "Please enter an API key.", { sticky: false });
      return;
    }

    notify("info", "Validating API key...");

    const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI_IPC__;
    if (!isTauri) {
      notify("error", "The app's background service is not available. Restart ROAM Logger and try again.");
      return;
    }

    try {
      const result = await invoke<string>("store_api_key", { key: keyToValidate });
      notify(toneOf(result) === "error" ? "error" : "success", result);
      setIsApiKeyValid(true);
      setApiKey("");
    } catch (error) {
      notify("error", `${error}`);
      setIsApiKeyValid(false);
    }
  };

  const handleSendMessage = async () => {
    if (!chatInput.trim()) return;
    setChatNote(null);

    // Stop voice listening the moment the user sends the message. If the
    // microphone is still on it would keep capturing audio while the AI is
    // processing and stream stale text into chatInput - confusing and noisy.
    if (isRecording && recognition) {
      try { const r: any = recognition; if (r.abort) r.abort(); else r.stop(); } catch (e) { /* already stopped */ }
      setIsRecording(false);
    }

    const userMsg = chatInput;
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setChatInput("");
    setIsAiLoading(true);

    try {
      const userHistory = messages
        .filter(m => m.role === 'user')
        .map(m => m.content);

      let response = await invoke<string>("chat_with_ai", { 
        prompt: userMsg,
        history: userHistory
      });
      
      // Check if the response contains JSON to populate the form
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          // Attempt to sanitize potential trailing garbage if JSON is truncated
          let jsonString = jsonMatch[0];
          try {
            JSON.parse(jsonString);
          } catch (e) {
            // If parsing fails, try to find the last closing brace to fix truncation
            const lastBrace = jsonString.lastIndexOf('}');
            if (lastBrace !== -1) {
              jsonString = jsonString.substring(0, lastBrace + 1);
            }
          }

          const data = JSON.parse(jsonString);
          
          const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
          const updateField = async (id: string, value: any, setter: (v: any) => void) => {
            setter(value);
            if (id !== 'cardType') {
              setHighlightedFields(prev => new Set(prev).add(id));
            }
            await sleep(150);
          };

          if (data.project && !isProjectLocked) {
            const matchedProject = projectsList.find(p => 
              p.toLowerCase().includes(data.project.toLowerCase())
            );
            if (matchedProject) await updateField('project', matchedProject, setProject);
          }
          if (data.office && !isOfficeLocked) {
            const matchedOffice = citiesList.find(c => 
              c.toLowerCase().includes(data.office.toLowerCase())
            );
            if (matchedOffice) await updateField('office', matchedOffice, setOffice);
          }
          if ((data.address || data.exactLoc) && !isAddressLocked) {
            const searchStr = (data.address || data.exactLoc).toLowerCase();
            const matchedAddress = streetsList.find(s => 
              s.toLowerCase().includes(searchStr)
            );
            if (matchedAddress) await updateField('address', matchedAddress, setAddress);
          }
          if (data.exactLoc && data.exactLoc.trim() !== "") {
            await updateField('exactLoc', data.exactLoc, setExactLoc);
          } else {
            const fallbackLoc = address.trim() !== "" ? address : "Undetermined";
            await updateField('exactLoc', fallbackLoc, setExactLoc);
          }
          
          if (data.date) {
            // Support dd/MMM/yyyy format from AI
            const parts = data.date.split('/');
            if (parts.length === 3) {
                const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const monthIdx = months.indexOf(parts[1]);
                if (monthIdx !== -1) {
                    const year = parseInt(parts[2]);
                    const month = String(monthIdx + 1).padStart(2, '0');
                    const day = String(parseInt(parts[0])).padStart(2, '0');
                    const isoDate = `${year}-${month}-${day}`;
                    await updateField('date', isoDate, setDate);
                }
            }
          }
          
          if (data.time) {
            // Ensure 24h format and no AM/PM
            const cleanTime = data.time.replace(/\s?[AP]M/i, '').trim();
            await updateField('time', cleanTime, setTime);
          } else {
            const now = new Date();
            const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            await updateField('time', nowTime, setTime);
          }
          if (data.isContractor !== undefined) await updateField('isContractor', data.isContractor === "Yes", setIsContractor);
          if (data.isWorkHours !== undefined) await updateField('isWorkHours', data.isWorkHours === "Yes", setIsWorkHours);
          if (data.obsType) await updateField('obsType', data.obsType, setObsType);
          if (data.obsSafe) await updateField('obsSafe', data.obsSafe, setObsSafe);
          if (data.officeLoc) await updateField('officeLoc', data.officeLoc, setOfficeLoc);
          if (data.details) await updateField('details', data.details, setDetails);
          if (data.action) await updateField('action', data.action, setAction);
          if (data.category) await updateField('category', data.category, setCategory);
          if (data.cardType) await updateField('cardType', data.cardType, setCardType);

          // Only fill in default date if the observation could not determine a date and it is currently empty
          if (!data.date && !date) {
            const today = new Date();
            await updateField('date', today.toISOString().split("T")[0], setDate);
          }

          // Only show completion message if no error was reported by AI
          if (data.error) {
            setMessages(prev => [...prev, { role: 'ai', content: data.error }]);
            setIsAiLoading(false);
            return;
          }

          // Remove the JSON block and the specific intro text from the displayed message
          let cleanMessage = response.replace(jsonMatch[0], "").trim();
          cleanMessage = cleanMessage.replace("Based on your description, here's the extracted safety observation details:", "").trim();
          
          if (!cleanMessage && data.error) {
            cleanMessage = data.error;
          } else if (!cleanMessage) {
            cleanMessage = "Observation processed successfully.";
          }

          setMessages(prev => [...prev, { role: 'ai', content: cleanMessage }]);
        } catch (e) {
          // If JSON was found but failed to parse even after sanitization
          setMessages(prev => [...prev, { role: 'ai', content: "I couldn't build an observation with your details. Please elaborate the observation description and try again." }]);
        }
      } else {
        // If no JSON structure was found at all
        setMessages(prev => [...prev, { role: 'ai', content: "I couldn't build an observation with your details. Please elaborate the observation description and try again." }]);
      }
    } catch (error: any) {
      let errorMessage = `Error: ${error}`;
      if (errorMessage.includes("503")) {
        errorMessage = "AI Model not available at this moment. Please try again later";
      }
      setMessages(prev => [...prev, { role: 'ai', content: errorMessage }]);
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleStartRecording = () => {
    if (!recognition) {
      setChatNote({ text: "Voice input is not supported on this computer. Please type your observation instead.", tone: "error" });
      return;
    }

    if (isRecording) {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      try {
        recognition.stop();
      } catch (e) {
        console.error("Stop error:", e);
      }
      setIsRecording(false);
    } else {
      try {
        setChatInput(""); // Clear input when starting new recording
        setChatNote(null);
        recognition.start();
        setIsRecording(true);
        
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = setTimeout(() => {
          if (recognition) {
            try { recognition.stop(); } catch(e) {}
          }
        }, 45000); // maximum recording length
      } catch (err) {
        console.error("Failed to start recognition:", err);
        setIsRecording(false);
        setChatNote({ text: "Could not start the microphone. Check that the app is allowed to use it.", tone: "error" });
      }
    }
  };

  const formatDateStr = (dStr: string) => {
    if (!dStr) return "";
    const d = new Date(dStr);
    const day = String(d.getDate()).padStart(2, '0');
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${day}/${months[d.getMonth()]}/${d.getFullYear()}`;
  };

  const handleSetToday = () => {
    setDate(new Date().toISOString().split("T")[0]);
    removeHighlight('date');
  };
  const handleSetNow = () => {
    const now = new Date();
    setTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
    removeHighlight('time');
  };

  const removeHighlight = (field: string) => {
    setHighlightedFields(prev => {
      const next = new Set(prev);
      next.delete(field);
      return next;
    });
  };

  // Keys match the data-field attributes on the form inputs.
  const getMissingFields = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const selectedDate = new Date(date);
    selectedDate.setHours(0, 0, 0, 0);
    const missing: string[] = [];
    if (!projectsList.includes(project)) missing.push("project");
    if (!citiesList.includes(office)) missing.push("office");
    if (!streetsList.includes(address)) missing.push("address");
    if (exactLoc.trim() === "") missing.push("exactLoc");
    if (date === "" || selectedDate > today) missing.push("date");
    if (time === "") missing.push("time");
    if (details.trim() === "") missing.push("details");
    if (action.trim() === "") missing.push("action");
    if (!CATEGORIES_LIST.includes(category)) missing.push("category");
    return missing;
  };

  const isFormValid = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const selectedDate = new Date(date);
    selectedDate.setHours(0, 0, 0, 0);

    return (
      projectsList.includes(project) &&
      citiesList.includes(office) &&
      streetsList.includes(address) &&
      CATEGORIES_LIST.includes(category) &&
      exactLoc.trim() !== "" &&
      date !== "" &&
      selectedDate <= today &&
      time !== "" &&
      details.trim() !== "" &&
      action.trim() !== ""
    );
  };

  const handleCancel = async () => {
    try {
      await invoke("cancel_submission");
      setSubmitProgress("Cancelling...");
    } catch (error) {
      console.error("Cancel failed", error);
    }
  };

  // Wraps submit_observation with one silent re-activation retry when the
  // failure is "could not reach the ROAM website" (the classic stale-NTLM case).
  // Use this from handleSubmit instead of calling invoke("submit_observation") directly.
  const submitObservationWithAutoReconnect = async (payloadJson: string, headless: boolean): Promise<string> => {
    try {
      return await invoke<string>("submit_observation", { payload: payloadJson, headless });
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes("Could not reach the ROAM website")) {
        setSubmitProgress("Reconnecting to ROAM...");
        try {
          await invoke("activate_handshake");
          await refreshActivationAge();
          setIsActivated(true);
          setActivationError(false);
          localStorage.setItem("roam_activated", "true");
          setSubmitProgress("Reconnected, retrying...");
          return await invoke<string>("submit_observation", { payload: payloadJson, headless });
        } catch (reactErr) {
          throw new Error(`${errStr}\n\nAuto-reconnect also failed: ${reactErr}`);
        }
      }
      throw err;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) {
      handleCancel();
      return;
    }
    if (!isFormValid()) {
      // Outline what is missing and take the user to the first one.
      setShowFieldErrors(true);
      const first = getMissingFields()[0];
      const el = first ? document.querySelector<HTMLElement>(`[data-field="${first}"]`) : null;
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.focus({ preventScroll: true }); }
      return;
    }
    const payload = { project, office, address, exactLoc, date: formatDateStr(date), time, isContractor, isWorkHours, obsType, obsSafe, officeLoc, details, action, category, cardType };
    setShowFieldErrors(false);
    setSubmitProgress("Starting submission...");
    setIsSubmitting(true);

    try {
      const result = await submitObservationWithAutoReconnect(
        JSON.stringify(payload),
        !isDebugVisible
      );
      notify(toneOf(result), result);
      if (toneOf(result) === "success") recordSubmission("confirmed", date);
    } catch (error: any) {
      const errStr = `${error}`;
      notify("error", errStr, { action: { label: "Try again", run: () => formRef.current?.requestSubmit() } });
      // Submitted, but ROAM's "saved" message was not seen: count it as
      // waiting for verification until the official counts include it.
      if (errStr.includes("Submit button was clicked")) recordSubmission("pending", date);
      // If we still could not reach ROAM after the auto-reconnect attempt,
      // mark the connection as broken so the user sees the Connect button
      // light up again.
      if (errStr.includes("Could not reach the ROAM website") || errStr.includes("Auto-reconnect also failed")) {
        setIsActivated(false);
        localStorage.removeItem("roam_activated");
      }
    } finally {
      setIsSubmitting(false);
      setSubmitProgress("");
    }
  };

  const inputStyle = { width: "100%", padding: "6px 8px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.input_text, fontFamily: "inherit", fontSize: "13px", boxSizing: "border-box" as const, userSelect: "text" as const };
  const labelStyle = { fontSize: "11px", fontWeight: "bold", color: colors.text, marginBottom: "2px", display: "block", letterSpacing: "0.3px", userSelect: "none" as const };
  const btnStyle = { padding: "6px 10px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, fontWeight: "bold", color: colors.text, fontSize: "11px", cursor: "pointer", fontFamily: "inherit" };
  const panelStyle = { border: `1px solid ${colors.border}`, borderRadius: "8px", overflow: "hidden" as const, backgroundColor: colors.card_bg };
  const panelHeaderStyle = { padding: "6px 10px", minHeight: "36px", boxSizing: "border-box" as const, backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, fontWeight: "bold", fontSize: "13px", display: "flex", justifyContent: "space-between", alignItems: "center" };
  // Selected choice = filled primary; AI-filled (highlighted) keeps the sage tint.
  const choiceStyle = (selected: boolean, highlighted: boolean) => ({
    ...btnStyle, flex: 1, padding: "8px",
    backgroundColor: selected ? (highlighted ? colors.sage : colors.primary) : colors.input_bg,
    color: selected && !highlighted ? "#FFFFFF" : colors.text,
    borderColor: selected ? colors.primary : colors.border,
  });
  const toggleStyle = (on: boolean, highlighted: boolean) => ({
    width: "50px", height: "28px", backgroundColor: highlighted ? colors.sage : (on ? colors.primary : colors.toggle_off), borderRadius: "14px", position: "relative" as const, cursor: "pointer", display: "flex", alignItems: "center", padding: "0 6px", boxSizing: "border-box" as const, justifyContent: on ? "flex-start" : "flex-end", transition: "background-color 0.2s", flexShrink: 0,
  });
  // Square icon-only button; pass `filled` for the active/primary state.
  const iconBtnStyle = (filled = false) => ({
    ...btnStyle, width: "32px", padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    backgroundColor: filled ? colors.primary : colors.input_bg, borderColor: filled ? colors.primary : colors.border, color: filled ? "#FFFFFF" : colors.text_muted,
  });
  const lockButton = (locked: boolean, toggle: () => void, field: string) => (
    <button type="button" onClick={toggle} title={locked ? `Unlock ${field}` : `Lock ${field} so it stays between observations`} aria-label={locked ? `Unlock ${field}` : `Lock ${field}`} aria-pressed={locked}
      className={locked ? undefined : "icon-btn"} style={iconBtnStyle(locked)}>
      <LockIcon locked={locked} />
    </button>
  );
  const connectionState = isActivating && !activationError ? "connecting" : activationError ? "error" : isActivated ? "connected" : "disconnected";
  const connectionLabel = connectionState === "error"
    ? `${connectionDetail || "ROAM connection error"} - click to retry`
    : connectionDetail || { connecting: "Connecting to ROAM...", error: "", connected: "Connected to ROAM", disconnected: "Not connected - click to connect to ROAM" }[connectionState];
  const canSendChat = isApiKeyValid && isActivated && chatInput.trim().length > 0;
  const missingFields = showFieldErrors ? getMissingFields() : [];
  // Red outline on a missing field (class overrides the inline border).
  const errCls = (field: string) => missingFields.includes(field) ? "field-error" : undefined;
  const toneColors = (tone: Tone) => ({
    border: tone === "error" ? colors.error_red : tone === "success" ? colors.success : colors.border,
    bg: tone === "error" ? colors.error_bg : tone === "success" ? colors.success_bg : colors.card_bg,
    fg: tone === "error" ? colors.error_red : tone === "success" ? (isDark ? "#6FCF97" : colors.success) : colors.text,
  });



  // Hide the warmup overlay once the app is genuinely ready for the user.
  // This means all three of:
  //   1) Project data loaded (projectsList populated from SharePoint or cache)
  //   2) ROAM connection established (isActivated true)
  //   3) Warmup either not needed (already done for this version) or completed
  //
  // The overlay transitions: loading -> success (briefly) -> null (main app).
  // The brief "success" state is the satisfying green-check moment.
  //
  // Located here, just before the overlay render guard, to guarantee that
  // every state variable it references has already been declared above.
  useEffect(() => {
    console.log(`[readiness] useEffect fired. warmupState=${warmupState}, projectsList.length=${projectsList.length}`);
    if (warmupState !== "loading") {
      console.log(`[readiness] Bailing because warmupState is "${warmupState}", not "loading"`);
      return;
    }

    const projectsReady = projectsList.length > 0;
    console.log(`[readiness] projectsReady=${projectsReady}`);

    (async () => {
      let warmupReady = false;
      try {
        const stillNeeded = await invoke<boolean>("is_warmup_needed");
        warmupReady = !stillNeeded;
        console.log(`[readiness] is_warmup_needed returned ${stillNeeded}, warmupReady=${warmupReady}`);
      } catch (e) {
        warmupReady = true;
        console.warn(`[readiness] is_warmup_needed threw, defaulting warmupReady=true`, e);
      }

      console.log(`[readiness] Final check: projectsReady=${projectsReady}, warmupReady=${warmupReady}`);
      if (projectsReady && warmupReady) {
        console.log(`[readiness] ALL CONDITIONS MET - no setup needed, hiding overlay`);
        console.log(`[readiness] Hiding overlay (setting warmupState to null)`);
        setWarmupState(null);
      } else {
        console.log(`[readiness] Conditions NOT met - overlay stays loading`);
      }
    })();
  }, [warmupState, projectsList.length]);

  // Shared `?` dropdown content - used by both the main app's `?` button and
  // the warmup overlay's `?` button. Wrapped in a function so the overlay can
  // call it without us duplicating the markup.
  const renderQuestionMenu = () => (
    <>
      <span>Roam Observation Logger v0.6.5{updateProgress !== null ? ` (downloading ${updateProgress}%)` : ""}</span>
      {pendingUpdate && (
        <button
          onClick={(e) => { e.stopPropagation(); handleInstallUpdate(); }}
          disabled={isInstallingUpdate || isSubmitting}
          style={{ ...btnStyle, padding: "3px 8px", fontSize: "11px", backgroundColor: colors.error_red, color: "white", borderColor: colors.error_red, width: "100%", cursor: isInstallingUpdate || isSubmitting ? "not-allowed" : "pointer", opacity: isInstallingUpdate || isSubmitting ? 0.6 : 1 }}
        >
          {isInstallingUpdate ? "Installing..." : (isSubmitting ? `v${pendingUpdate.version} ready (finish submission first)` : `Install update v${pendingUpdate.version}`)}
        </button>
      )}
      <button onClick={(e) => { e.stopPropagation(); handleSendFeedback(); setShowVersion(false); }} style={{ ...btnStyle, padding: "3px 8px", fontSize: "11px", backgroundColor: colors.bg, width: "100%" }}>Send Feedback</button>
    </>
  );

  // Show the last saved counts straight away, then check Power BI in the
  // background on every launch. The check runs on its own copy of the Edge
  // sign-in, so the app (and submissions) stay responsive meanwhile.
  const obsStartedRef = useRef(false);
  useEffect(() => {
    if (obsStartedRef.current || warmupState !== null || !startupReady) return;
    obsStartedRef.current = true;
    (async () => {
      let cached: ObservationCounts | null = null;
      try { cached = await invoke<ObservationCounts | null>("get_cached_observation_counts"); } catch { cached = null; }
      if (cached) showObsData(cached);
      loadObservationCounts(false);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warmupState, startupReady]);

  // Once the user's location/discipline arrives with their own counts, load
  // the leaderboard that was opened while waiting for it.
  useEffect(() => {
    if (boardOpenedRef.current && boardScope !== "crew" && obsData?.groups?.[boardScope]) openBoard(boardScope);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obsData?.groups?.location, obsData?.groups?.discipline, boardScope]);

  // If warmup is still in progress, show ONLY the overlay. The main app does
  // not render at all until warmup completes successfully.
  if (warmupState !== null || !startupReady) {
    return (
      <WarmupOverlay
        state={warmupState ?? "loading"}
        attempt={warmupAttempt}
        maxAttempts={3}
        networkRetrySeconds={networkRetrySeconds}
        onRetry={() => setWarmupRetryNonce(n => n + 1)}
          onSkip={() => setWarmupState(null)}
          failureDetail={warmupFailureDetail}
        isDark={isDark}
        renderQuestionMenu={renderQuestionMenu}
      />
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "16px", backgroundColor: colors.bg, color: colors.text, fontFamily: "'Source Sans 3', 'Source Sans Pro', Arial, sans-serif", fontSize: "13px", padding: "16px", minHeight: "100vh", boxSizing: "border-box", userSelect: "none" }}>
    <MonthlySidebar
      year={trackerYear}
      counts={sidebarCounts}
      pending={sidebarPending}
      board={obsConfigured && observerName ? {
        scope: boardScope,
        options: [
          { value: "location", label: groups.location ? `${groups.location} (location)` : "My reporting location" },
          { value: "discipline", label: groups.discipline ? `${groups.discipline} (discipline)` : "My discipline" },
          { value: "crew", label: `My crew (${crew.length})` },
        ],
        onScope: chooseBoardScope,
        monthLabel: trackerNow.toLocaleString("en", { month: "long" }),
        top: ranking?.top ?? [],
        me: ranking?.me ?? null,
        total: ranking?.total ?? 0,
        onTarget: ranking?.onTarget ?? 0,
        complete: activeBoard?.complete ?? true,
        loading: onCrewBoard ? crewLoading : boardLoading,
        error: onCrewBoard ? crewError : boardError,
        updatedLabel: onCrewBoard ? (crewData ? updatedAgo(crewData.fetchedAt) : "never") : activeBoard ? updatedAgo(activeBoard.fetchedAt) : "never",
        onRefresh: () => (onCrewBoard ? loadCrew(crew, true) : loadBoard(boardScope, true)),
        crewHint: onCrewBoard && crew.length === 0,
        onManageCrew: onCrewBoard ? () => setShowCrew(true) : undefined,
        nudge: onCrewBoard ? r => (r.isMe || r.count >= MONTHLY_TARGET ? null : nudgedRecently(r.name) ? "sent" : "ready") : undefined,
        onNudge: r => nudge(r.name, r.count),
        onCopyCrew: onCrewBoard && crew.length ? copyCrew : undefined,
        onExportCrew: onCrewBoard && crew.length ? exportCrew : undefined,
        onOpen: () => openBoard(boardScope),
        waitingFor: boardWaitingFor,
        onPick: name => {
          if (name === observerName || !activeBoard) { setViewing(null); return; }
          // Their months are already in the leaderboard data: show them instantly.
          setViewing({ name, loading: false, error: "", data: { observers: { [name]: activeBoard.observers[name] ?? {} }, fetchedAt: activeBoard.fetchedAt, fromCache: activeBoard.fromCache, ageHours: activeBoard.ageHours, observer: name } });
        },
      } : undefined}
      now={trackerNow}
      colors={colors}
      onShuffle={obsConfigured ? undefined : () => setMonthlyCounts(generateRandomMonthlyCounts(trackerYear))}
      live={obsConfigured ? {
        observer: observerName,
        hasData: viewing ? viewingHasData : obsHasData || localObs.length > 0,
        onLookup: () => setShowLookup(true),
        onOpenCrew: () => setShowCrew(true),
        crewSize: crew.length,
        viewing: viewing ? {
          name: viewing.name, loading: viewing.loading, error: viewing.error, onClear: () => setViewing(null),
          inCrew: crew.some(c => sameName(c, viewing.name)),
          onAddToCrew: () => addToCrew([viewing.name], viewing.data ? { observers: viewing.data.observers, matches: [], unmatched: [], fetchedAt: viewing.data.fetchedAt } : undefined),
        } : null,
        updatedLabel: obsData ? updatedAgo(obsData.fetchedAt) : "never",
        loading: obsLoading,
        error: obsError,
        onRefresh: () => loadObservationCounts(true),
      } : undefined}
    />
    <div style={{ flex: 1, minWidth: 0 }}>
          <style>{`
      @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
      .voice-blinker { animation: blink 1s linear infinite; color: ${colors.primary}; font-weight: bold; }
      input:focus, textarea:focus { outline: none; border-color: ${colors.primary} !important; box-shadow: 0 0 0 1px ${colors.primary}; }
      button:focus-visible, [tabindex]:focus-visible { outline: 2px solid ${colors.primary}; outline-offset: 1px; }
      @keyframes roam-spin { to { transform: rotate(360deg); } }
      @keyframes roam-rec { 0% { box-shadow: 0 0 0 0 ${colors.primary}80; } 100% { box-shadow: 0 0 0 8px ${colors.primary}00; } }
      .chat-box:focus-within { border-color: ${colors.primary} !important; box-shadow: 0 0 0 1px ${colors.primary}; }
      .chat-box textarea:focus { border-color: transparent !important; box-shadow: none; }
      .icon-btn:not(:disabled):hover { background-color: ${colors.surface} !important; }
      .field-error { border-color: ${colors.error_red} !important; box-shadow: 0 0 0 1px ${colors.error_red} !important; }
      @keyframes roam-toast-in { from { transform: translateY(-8px); opacity: 0; } to { transform: none; opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .roam-toast { animation: none !important; } }
      html, body { background-color: ${colors.bg}; margin: 0; padding: 0; }
      input[type="password"]::-ms-reveal, input[type="password"]::-ms-clear { display: none; }
      input[type="date"]::-webkit-calendar-picker-indicator { filter: ${isDark ? 'invert(1)' : 'none'}; }
      input[type="time"]::-webkit-calendar-picker-indicator { filter: ${isDark ? 'invert(1)' : 'none'}; }
      ::-webkit-scrollbar { width: 8px; }
      ::-webkit-scrollbar-track { background: ${colors.bg}; }
      ::-webkit-scrollbar-thumb { background: ${colors.border}; border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: ${colors.text_muted}; }
    `}</style>
      {/* Pop-up notices */}
      {/* Sits just below the header bar so the status and info icons stay clickable */}
      <div aria-live="polite" style={{ position: "fixed", top: "60px", right: "24px", zIndex: 2000, width: "min(340px, calc(100vw - 32px))", display: "flex", flexDirection: "column", gap: "8px", pointerEvents: "none" }}>
        {toasts.map(t => {
          const tc = toneColors(t.tone);
          return (
            <div key={t.id} className="roam-toast" role={t.tone === "error" ? "alert" : "status"} style={{ pointerEvents: "auto", display: "flex", alignItems: "flex-start", gap: "8px", padding: "8px 8px 8px 10px", borderRadius: "4px", border: `1px solid ${tc.border}`, backgroundColor: tc.bg, color: tc.fg, fontSize: "13px", boxShadow: "0 4px 14px rgba(0,0,0,0.15)", animation: "roam-toast-in 0.18s ease-out" }}>
              <span style={{ display: "flex", paddingTop: "1px", flexShrink: 0 }}>{t.tone === "success" ? <CheckCircleIcon /> : t.tone === "error" ? <AlertIcon /> : <InfoIcon />}</span>
              <span style={{ flex: 1, minWidth: 0, lineHeight: 1.4, overflowWrap: "anywhere", userSelect: "text" }}>{t.message}</span>
              {t.action && (
                <button type="button" onClick={() => { dismissToast(t.id); t.action!.run(); }} style={{ ...btnStyle, padding: "2px 8px", flexShrink: 0, backgroundColor: colors.card_bg, borderColor: tc.border, color: tc.fg }}>{t.action.label}</button>
              )}
              <button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss" title="Dismiss" style={{ border: "none", background: "none", color: tc.fg, cursor: "pointer", padding: "2px", display: "flex", flexShrink: 0, opacity: 0.7 }}><CloseIcon /></button>
            </div>
          );
        })}
      </div>

      {/* Settings */}
      {!isApiKeyValid && !isInitialLoading && (
        <div style={{ marginBottom: "16px", padding: "10px", backgroundColor: colors.card_bg, border: `1px solid ${colors.border}`, borderRadius: "8px" }}>
          <label style={labelStyle}>GEMINI API KEY</label>
          <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
            <div style={{ position: "relative", flex: 1 }}>
              <input 
                type={showKey ? "text" : "password"} 
                value={apiKey} 
                onChange={e => setApiKey(e.target.value)} 
                placeholder="Enter Gemini API Key" 
                style={inputStyle} 
              />
              <button 
                type="button" 
                onClick={() => setShowKey(!showKey)}
                title={showKey ? "Hide key" : "Show key"}
                aria-label={showKey ? "Hide key" : "Show key"}
                style={{ position: "absolute", right: "6px", top: "50%", transform: "translateY(-50%)", border: "none", background: "none", cursor: "pointer", padding: "2px", display: "flex", color: colors.text_muted }}
              >
                {showKey ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
            <button onClick={handleSaveApiKey} style={btnStyle}>Save Key</button>
            <button type="button" onClick={() => setShowKeyModal(true)} style={{ ...btnStyle, backgroundColor: colors.surface }}>Get Key</button>
          </div>
          <div style={{ fontSize: "11px", color: colors.text_muted }}>
            A valid API key is required for ROAM AI features.
          </div>
        </div>
      )}

      {/* Get Key Modal */}
      {showKeyModal && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.modal_overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
          <div style={{ backgroundColor: colors.modal_bg, color: colors.text, padding: "24px", borderRadius: "8px", maxWidth: "400px", textAlign: "center", boxShadow: "0 4px 20px rgba(0,0,0,0.3)" }}>
            <h3 style={{ marginTop: 0 }}>Get Free API Key</h3>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px" }}>
              <QRCodeSVG value="https://aistudio.google.com" size={150} fgColor={colors.text} bgColor={colors.modal_bg} />
            </div>
            <p style={{ fontSize: "13px", textAlign: "left", lineHeight: "1.5" }}>
              1. Scan QR or visit <strong>aistudio.google.com</strong><br/>
              2. Sign in with a Google account.<br/>
              3. Click <strong>"Get API key"</strong> in the sidebar.<br/>
              4. Create a key in a new project.<br/>
              5. Copy and paste it here.
            </p>
            <button onClick={() => setShowKeyModal(false)} style={{ ...btnStyle, width: "100%", padding: "10px", backgroundColor: colors.primary, color: "white" }}>Close</button>
          </div>
        </div>
      )}

      {/* Secret Debug Menu */}
      {showDebugMenu && (
    <div style={{ marginBottom: "16px", padding: "10px", backgroundColor: colors.debug_bg, border: `1px solid ${colors.debug_border}`, borderRadius: "8px", display: "flex", flexDirection: "column", gap: "10px" }}>
    <div style={{ fontSize: "13px", fontWeight: "bold", color: colors.debug_text }}>DEBUG SETTINGS</div>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "11px" }}>
            <input type="checkbox" checked={isDebugVisible} onChange={e => setIsDebugVisible(e.target.checked)} />
            Show browser and automation steps (Not Headless)
          </label>
          <button 
            type="button" 
            onClick={handleClearApiKey} 
            style={{ ...btnStyle, backgroundColor: colors.card_bg, borderColor: colors.error_red, color: colors.error_red, width: "fit-content" }}
          >
            Clear API Key
          </button>
          <button 
            type="button" 
            onClick={() => {
              setIsActivated(false);
              localStorage.removeItem("roam_activated");
              setActivationError(false);
              setConnectionDetail("");
              notify("info", "Activation cleared. Click the status icon to reconnect.");
            }} 
            style={{ ...btnStyle, backgroundColor: colors.card_bg, borderColor: colors.debug_text, color: colors.debug_text, width: "fit-content" }}
          >
            Clear Activation
          </button>
          <button
            type="button"
            onClick={handleInspectReport}
            disabled={isInspecting}
            style={{ ...btnStyle, backgroundColor: colors.card_bg, borderColor: colors.debug_text, color: colors.debug_text, width: "fit-content", cursor: isInspecting ? "wait" : "pointer" }}
          >
            {isInspecting ? "Reading observation data..." : "Inspect observation data"}
          </button>
        </div>
      )}

      {showLookup && (
        <NameSearchModal
          colors={colors}
          knownNames={obsData ? Object.keys(obsData.observers).sort((a, b) => a.localeCompare(b)) : []}
          current={viewing?.name ?? observerName}
          onSearchReport={query => invoke<string[]>("search_report_names", { query })}
          onChoose={viewPerson}
          crew={crew}
          onAddToCrew={name => addToCrew([name])}
          onClose={() => setShowLookup(false)}
        />
      )}

      {showCrew && (
        <CrewModal
          colors={colors}
          crew={crew}
          progress={crewProgress}
          onRemove={removeFromCrew}
          onMatch={lines => invoke<PasteResult>("match_pasted_people", { lines })}
          onAdd={(names, result) => addToCrew(names, result)}
          onCopy={copyCrew}
          onExport={exportCrew}
          onClose={() => setShowCrew(false)}
        />
      )}

      {/* Power BI inspection result (debug) */}
      {inspectResult !== null && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: colors.modal_overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
          <div style={{ backgroundColor: colors.modal_bg, color: colors.text, padding: "16px", borderRadius: "8px", width: "100%", maxWidth: "640px", maxHeight: "80vh", display: "flex", flexDirection: "column", gap: "10px", boxShadow: "0 4px 20px rgba(0,0,0,0.3)" }}>
            <div style={{ fontSize: "15px", fontWeight: "bold" }}>Observation data contents</div>
            <div style={{ fontSize: "13px", color: colors.text_muted }}>Each block is one visual. Copy this and send it over so the right columns can be set in the config. Also saved as powerbi-inspect.json in the app data folder.</div>
            <pre style={{ flex: 1, overflow: "auto", margin: 0, padding: "8px", fontSize: "11px", backgroundColor: colors.surface, border: `1px solid ${colors.border}`, borderRadius: "4px", userSelect: "text", whiteSpace: "pre-wrap" }}>{inspectResult}</pre>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" onClick={() => { navigator.clipboard.writeText(inspectResult).then(() => notify("success", "Copied."), () => notify("error", "Could not copy. Select the text and copy it instead.")); }} style={btnStyle}>Copy</button>
              <button type="button" onClick={() => setInspectResult(null)} style={{ ...btnStyle, backgroundColor: colors.primary, borderColor: colors.primary, color: "#FFFFFF" }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Chat Interface */}
      {/* App header + ROAM AI chat. The panel's header bar holds the title and app-level controls. */}
      <div style={{ ...panelStyle, overflow: "visible", marginBottom: "16px" }}>
        <div style={{ ...panelHeaderStyle, borderRadius: "8px 8px 0 0", gap: "8px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px", minWidth: 0 }}>
            <span style={{ fontSize: "15px", whiteSpace: "nowrap" }}>Roam Observation Logger</span>
            <span style={{ fontSize: "11px", fontWeight: "normal", color: colors.text_muted, whiteSpace: "nowrap" }}>with ROAM AI</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
            {!isApiKeyValid && <span style={{ color: colors.warning, fontSize: "11px" }}>Connect API Key to enable chat</span>}
            <button 
              onClick={handleNewChat} 
              title="New chat"
              aria-label="New chat"
              className="icon-btn"
              style={{ width: "24px", height: "24px", padding: 0, border: "none", borderRadius: "4px", background: "none", color: colors.text_muted, cursor: isApiKeyValid ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center" }}
              disabled={!isApiKeyValid}
            >
              <NewChatIcon />
            </button>
            <div style={{ width: "1px", height: "16px", backgroundColor: colors.border, margin: "0 4px" }} />
      <button
        onClick={(!isActivated && !isActivating) || activationError ? () => { setActivationError(false); handleActivate(); } : undefined}
        disabled={isActivated || (isActivating && !activationError)}
        title={connectionLabel}
        aria-label={connectionLabel}
        className="icon-btn"
        style={{ width: "24px", height: "24px", padding: 0, border: "none", borderRadius: "50%", background: "none", display: "flex", alignItems: "center", justifyContent: "center",
          color: connectionState === "connected" ? colors.success : connectionState === "error" ? colors.error_red : colors.text_muted,
          cursor: connectionState === "connected" ? "default" : connectionState === "connecting" ? "wait" : "pointer" }}
      >
        <ConnectionIcon state={connectionState} />
      </button>

      <div ref={themeMenuRef} style={{ position: "relative" }}>
        <button
          onClick={() => { setShowThemeMenu(!showThemeMenu); setShowVersion(false); }}
          title={`Colour theme: ${themePref === "system" ? "System" : themePref === "dark" ? "Dark" : "Light"}`}
          aria-label="Colour theme"
          aria-haspopup="menu"
          aria-expanded={showThemeMenu}
          className="icon-btn"
          style={{ width: "24px", height: "24px", padding: 0, border: "none", borderRadius: "50%", background: "none", color: colors.text_muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          {themePref === "system" ? <MonitorIcon /> : themePref === "dark" ? <MoonIcon /> : <SunIcon />}
        </button>
        {showThemeMenu && (
          <div role="menu" aria-label="Colour theme" style={{ position: "absolute", top: "100%", right: 0, marginTop: "4px", padding: "4px", backgroundColor: colors.card_bg, border: `1px solid ${colors.border}`, borderRadius: "8px", boxShadow: "0 4px 14px rgba(0,0,0,0.15)", zIndex: 100, display: "flex", flexDirection: "column", gap: "2px", minWidth: "130px" }}>
            {([["light", "Light", <SunIcon key="i" />], ["dark", "Dark", <MoonIcon key="i" />], ["system", "System", <MonitorIcon key="i" />]] as const).map(([value, label, icon]) => (
              <button
                key={value}
                role="menuitemradio"
                aria-checked={themePref === value}
                onClick={() => { setThemePref(value); setShowThemeMenu(false); }}
                className="icon-btn"
                style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 8px", border: "none", borderRadius: "4px", background: "none", color: colors.text, fontFamily: "inherit", fontSize: "13px", fontWeight: themePref === value ? "bold" : "normal", cursor: "pointer", textAlign: "left" }}
              >
                <span style={{ display: "flex", color: colors.text_muted }}>{icon}</span>
                <span style={{ flex: 1 }}>{label}</span>
                <span style={{ display: "flex", width: "14px", color: colors.primary }}>{themePref === value && <CheckIcon />}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ position: "relative" }}>
        <button onClick={() => { setShowVersion(!showVersion); setShowThemeMenu(false); }} title={pendingUpdate ? `Update v${pendingUpdate.version} ready - click to install` : "App info"} aria-label="App info" className="icon-btn" style={{ width: "24px", height: "24px", padding: 0, border: "none", borderRadius: "50%", background: "none", color: colors.text_muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
          <InfoIcon size={18} />
          {pendingUpdate && <span style={{ position: "absolute", top: "-2px", right: "-2px", width: "10px", height: "10px", borderRadius: "50%", backgroundColor: colors.error_red, border: `1px solid ${colors.bg}` }} />}
        </button>
        {showVersion && <div style={{ position: "absolute", top: "100%", right: 0, marginTop: "4px", padding: "8px 12px", backgroundColor: colors.surface, border: `1px solid ${colors.border}`, borderRadius: "8px", fontSize: "11px", color: colors.text_muted, whiteSpace: "nowrap", zIndex: 100, display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-start" }}>
          <span>Roam Observation Logger v0.6.5{updateProgress !== null ? ` (downloading ${updateProgress}%)` : ""}</span>
          {pendingUpdate && (
            <button
              onClick={(e) => { e.stopPropagation(); handleInstallUpdate(); }}
              disabled={isInstallingUpdate || isSubmitting}
              style={{ ...btnStyle, padding: "3px 8px", fontSize: "11px", backgroundColor: colors.error_red, color: "white", borderColor: colors.error_red, width: "100%", cursor: isInstallingUpdate || isSubmitting ? "not-allowed" : "pointer", opacity: isInstallingUpdate || isSubmitting ? 0.6 : 1 }}
            >
              {isInstallingUpdate ? "Installing..." : (isSubmitting ? `v${pendingUpdate.version} ready (finish submission first)` : `Install update v${pendingUpdate.version}`)}
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); handleSendFeedback(); setShowVersion(false); }} style={{ ...btnStyle, padding: "3px 8px", fontSize: "11px", backgroundColor: colors.bg, width: "100%" }}>Send Feedback</button>
        </div>}
      </div>
          </div>
        </div>
        {/* Lasting warnings sit directly under the header bar */}
        {activationAgeHours !== null && activationAgeHours > 12 && !isActivated && (
          <div style={{ padding: "6px 10px", backgroundColor: colors.debug_bg, borderBottom: `1px solid ${colors.debug_border}`, fontSize: "13px", color: colors.debug_text, display: "flex", alignItems: "center", gap: "8px" }}>
            <WarningIcon />
            <span style={{ flex: 1 }}>Last connected {Math.round(activationAgeHours)} hours ago - consider reconnecting before submitting.</span>
            <button onClick={() => { setActivationError(false); handleActivate(); }} disabled={isActivating} style={{ ...btnStyle, padding: "2px 8px", whiteSpace: "nowrap", backgroundColor: colors.card_bg, borderColor: colors.debug_text, color: colors.debug_text }}>Reconnect now</button>
          </div>
        )}
        {appWarning && (
          <div style={{ padding: "6px 6px 6px 10px", backgroundColor: colors.debug_bg, borderBottom: `1px solid ${colors.debug_border}`, fontSize: "13px", color: colors.debug_text, display: "flex", alignItems: "center", gap: "8px" }}>
            <WarningIcon />
            <span style={{ flex: 1 }}>{appWarning}</span>
            <button type="button" onClick={() => setAppWarning("")} aria-label="Dismiss" title="Dismiss" style={{ border: "none", background: "none", color: colors.debug_text, cursor: "pointer", padding: "2px", display: "flex" }}><CloseIcon /></button>
          </div>
        )}
        <div style={{ opacity: isApiKeyValid ? 1 : 0.6 }}>
        <div style={{ height: "200px", overflowY: "auto", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {messages.map((msg, i) => (
            <div key={i} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', backgroundColor: msg.role === 'user' ? colors.primary : colors.surface, color: msg.role === 'user' ? 'white' : colors.text, padding: "6px 10px", borderRadius: "8px", fontSize: "13px", maxWidth: "80%", userSelect: "text" }}>
              {msg.content}
            </div>
          ))}
          {isAiLoading && <div style={{ fontSize: "13px", color: colors.text_muted }}>AI is thinking{loadingDots}</div>}
          {chatNote && (
            <div role="status" style={{ alignSelf: "center", display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: chatNote.tone === "error" ? colors.error_red : colors.text_muted, padding: "2px 8px" }}>
              {chatNote.tone === "error" ? <AlertIcon size={13} /> : <MicIcon size={13} />}
              <span>{chatNote.text}</span>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
        <div style={{ padding: "10px", borderTop: `1px solid ${colors.border}` }}>
          <div className="chat-box" style={{ display: "flex", alignItems: "flex-end", gap: "4px", padding: "4px 4px 4px 2px", border: `1px solid ${colors.border}`, borderRadius: "8px", backgroundColor: isApiKeyValid ? colors.input_bg : (isDark ? "#252525" : "#F5F5F5") }}>
          <textarea 
            value={chatInput} 
            onChange={e => {
              setChatInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = e.target.scrollHeight + 'px';
            }} 
            placeholder={isRecording ? "Listening... speak your observation" : (isApiKeyValid ? "Describe your observation, or tap the mic to speak..." : "API Key required")} 
            style={{ 
              ...inputStyle, 
              border: "none",
              backgroundColor: "transparent",
              height: "32px",
              minHeight: "32px",
              maxHeight: "300px",
              resize: "none",
              paddingTop: "7px",
              paddingBottom: "6px",
              lineHeight: "1.4"
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && isApiKeyValid && isActivated) {
                e.preventDefault();
                handleSendMessage();
                (e.target as HTMLTextAreaElement).style.height = '32px';
              }
            }}
            disabled={!isApiKeyValid}
            className={isRecording && !chatInput ? "voice-blinker" : ""}
          />
          <button
            onClick={handleStartRecording}
            disabled={!isApiKeyValid}
            title={isRecording ? "Stop voice log" : "Voice log"}
            aria-label={isRecording ? "Stop voice log" : "Voice log"}
            aria-pressed={isRecording}
            className={isRecording ? undefined : "icon-btn"}
            style={{ width: "32px", height: "32px", flexShrink: 0, padding: 0, border: "none", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
              backgroundColor: isRecording ? colors.primary : "transparent", color: isRecording ? "#FFFFFF" : colors.text_muted,
              animation: isRecording ? "roam-rec 1.2s ease-out infinite" : "none", cursor: isApiKeyValid ? "pointer" : "not-allowed" }}
          >
            {isRecording ? <StopIcon /> : <MicIcon size={18} />}
          </button>
          <button
            onClick={() => { handleSendMessage(); const area = document.querySelector('textarea'); if(area) area.style.height='32px'; }}
            disabled={!canSendChat}
            title="Send"
            aria-label="Send"
            style={{ width: "32px", height: "32px", flexShrink: 0, padding: 0, border: "none", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
              backgroundColor: canSendChat ? colors.primary : colors.locked_bg, color: canSendChat ? "#FFFFFF" : colors.text_muted, cursor: canSendChat ? "pointer" : "not-allowed" }}
          >
            <SendIcon />
          </button>
          </div>
        </div>
        </div>
      </div>

      {/* Form */}
      <form ref={formRef} onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>Where and when</div>
          <div style={{ padding: "10px", display: "grid", gridTemplateColumns: "90px 1fr", gap: "8px", alignItems: "center" }}>
          <label style={labelStyle}>PROJECT</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <div style={{ width: "100%", position: "relative" }}>
              <input
                list="projects-list"
                value={project} data-field="project" className={errCls("project")}
                onChange={e => {setProject(e.target.value); removeHighlight('project');}}
                disabled={isProjectLocked}
                placeholder="Search project..."
                style={{ 
                  ...inputStyle, 
              backgroundColor: isProjectLocked ? colors.locked_bg : (highlightedFields.has('project') ? colors.sage : colors.input_bg),
              color: project && !projectsList.includes(project) ? colors.error_red : colors.input_text
                }}
              />
              <datalist id="projects-list">
                {projectsList.map(p => <option key={p} value={p} />)}
              </datalist>
            </div>
            {lockButton(isProjectLocked, () => setIsProjectLocked(!isProjectLocked), "project")}
          </div>

          <label style={labelStyle}>OFFICE</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <div style={{ width: "100%", position: "relative" }}>
              <input
                list="cities-list"
                value={office} data-field="office" className={errCls("office")}
                onChange={e => {setOffice(e.target.value); removeHighlight('office');}}
                disabled={isOfficeLocked}
                placeholder="Search office..."
                style={{ 
                  ...inputStyle, 
              backgroundColor: isOfficeLocked ? colors.locked_bg : (highlightedFields.has('office') ? colors.sage : colors.input_bg),
              color: office && !citiesList.includes(office) ? colors.error_red : colors.input_text
                }}
              />
              <datalist id="cities-list">
                {citiesList.map(c => <option key={c} value={c} />)}
              </datalist>
            </div>
            {lockButton(isOfficeLocked, () => setIsOfficeLocked(!isOfficeLocked), "office")}
          </div>

          <label style={labelStyle}>ADDRESS</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <div style={{ width: "100%", position: "relative" }}>
              <input
                list="streets-list"
                value={address} data-field="address" className={errCls("address")}
                onChange={e => {setAddress(e.target.value); removeHighlight('address');}}
                disabled={isAddressLocked}
                placeholder="Search address..."
                style={{ 
                  ...inputStyle, 
              backgroundColor: isAddressLocked ? colors.locked_bg : (highlightedFields.has('address') ? colors.sage : colors.input_bg),
              color: address && !streetsList.includes(address) ? colors.error_red : colors.input_text
                }}
              />
              <datalist id="streets-list">
                {streetsList.map(s => <option key={s} value={s} />)}
              </datalist>
            </div>
            {lockButton(isAddressLocked, () => setIsAddressLocked(!isAddressLocked), "address")}
          </div>

          <label style={labelStyle}>LOCATION</label>
          <input value={exactLoc} data-field="exactLoc" className={errCls("exactLoc")} onChange={e => {setExactLoc(e.target.value); removeHighlight('exactLoc');}} placeholder="Exact location" style={{...inputStyle, backgroundColor: highlightedFields.has('exactLoc') ? colors.sage : colors.input_bg}} />

          <label style={labelStyle}>DATE</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <input 
              type="date" 
              value={date} data-field="date" className={errCls("date")} 
              onChange={e => {setDate(e.target.value); removeHighlight('date');}} 
              style={{
                ...inputStyle, 
                backgroundColor: highlightedFields.has('date') ? colors.sage : colors.input_bg,
                color: date && new Date(date).setHours(0,0,0,0) > new Date().setHours(0,0,0,0) ? colors.warning : colors.input_text
              }} 
            />
            <button type="button" onClick={handleSetToday} title="Set to today" aria-label="Set to today" className="icon-btn" style={iconBtnStyle()}><CalendarIcon /></button>
          </div>

          <label style={labelStyle}>TIME</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <input type="time" value={time} data-field="time" className={errCls("time")} onChange={e => {setTime(e.target.value); removeHighlight('time');}} style={{...inputStyle, backgroundColor: highlightedFields.has('time') ? colors.sage : colors.input_bg}} />
            <button type="button" onClick={handleSetNow} title="Set to now" aria-label="Set to now" className="icon-btn" style={iconBtnStyle()} tabIndex={1}><ClockIcon /></button>
          </div>
          </div>
        </div>

        <div style={panelStyle}>
          <div style={panelHeaderStyle}>What happened</div>
          <div style={{ padding: "10px", display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
            <span>Was the work performed by a Contractor?</span>
            <div 
              onClick={() => {setIsContractor(!isContractor); removeHighlight('isContractor');}} 
              tabIndex={2}
              onKeyDown={(e) => e.key === 'Enter' && (setIsContractor(!isContractor), removeHighlight('isContractor'))}
              style={toggleStyle(isContractor, highlightedFields.has('isContractor'))}
            >
              <span style={{ color: highlightedFields.has('isContractor') ? "black" : "white", fontSize: "11px", fontWeight: "bold" }}>{isContractor ? "Yes" : "No"}</span>
              <div style={{ width: "24px", height: "24px", backgroundColor: "white", borderRadius: "50%", position: "absolute", top: "2px", left: isContractor ? "24px" : "2px", transition: "left 0.2s" }} />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
            <span>Was this observed during working hours?</span>
            <div 
              onClick={() => {setIsWorkHours(!isWorkHours); removeHighlight('isWorkHours');}} 
              tabIndex={3}
              onKeyDown={(e) => e.key === 'Enter' && (setIsWorkHours(!isWorkHours), removeHighlight('isWorkHours'))}
              style={toggleStyle(isWorkHours, highlightedFields.has('isWorkHours'))}
            >
              <span style={{ color: highlightedFields.has('isWorkHours') ? "black" : "white", fontSize: "11px", fontWeight: "bold" }}>{isWorkHours ? "Yes" : "No"}</span>
              <div style={{ width: "24px", height: "24px", backgroundColor: "white", borderRadius: "50%", position: "absolute", top: "2px", left: isWorkHours ? "24px" : "2px", transition: "left 0.2s" }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Behaviour", "Condition"].map((t, idx) => <button key={t} type="button" tabIndex={idx === 0 ? 4 : undefined} onClick={() => {setObsType(t); removeHighlight('obsType');}} style={choiceStyle(obsType === t, highlightedFields.has('obsType'))}>{t}</button>)}
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Safe", "At Risk"].map(t => <button key={t} type="button" onClick={() => {setObsSafe(t); removeHighlight('obsSafe');}} style={choiceStyle(obsSafe === t, highlightedFields.has('obsSafe'))}>{t}</button>)}
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Hatch office", "Home office", "Site/Client"].map(t => <button key={t} type="button" onClick={() => {setOfficeLoc(t); removeHighlight('officeLoc');}} style={choiceStyle(officeLoc === t, highlightedFields.has('officeLoc'))}>{t}</button>)}
          </div>

          <div>
            <label style={labelStyle}>OBSERVATION DETAILS</label>
            <textarea value={details} data-field="details" className={errCls("details")} onChange={e => {setDetails(e.target.value); removeHighlight('details');}} placeholder="Enter observation details..." style={{ ...inputStyle, height: "60px", resize: "none", backgroundColor: highlightedFields.has('details') ? colors.sage : colors.input_bg }} />
          </div>

          <div>
            <label style={labelStyle}>IMMEDIATE ACTION</label>
            <textarea value={action} data-field="action" className={errCls("action")} onChange={e => {setAction(e.target.value); removeHighlight('action');}} placeholder="Enter immediate action taken..." style={{ ...inputStyle, height: "60px", resize: "none", backgroundColor: highlightedFields.has('action') ? colors.sage : colors.input_bg }} />
          </div>
          </div>
        </div>

        <div style={panelStyle}>
          <div style={panelHeaderStyle}>Classification</div>
          <div style={{ padding: "10px", display: "flex", flexDirection: "column", gap: "10px" }}>
          <div>
            <label style={labelStyle}>CATEGORY</label>
            <input
              list="categories-list"
              value={category} data-field="category" className={errCls("category")}
              onChange={e => {setCategory(e.target.value); removeHighlight('category');}}
              placeholder="Search category..."
              style={{ 
                ...inputStyle, 
                backgroundColor: highlightedFields.has('category') ? colors.sage : colors.input_bg,
                color: category && !CATEGORIES_LIST.includes(category) ? colors.error_red : colors.input_text
              }}
            />
            <datalist id="categories-list">
              {CATEGORIES_LIST.map(cat => <option key={cat} value={cat} />)}
            </datalist>
          </div>

          <div>
            <label style={labelStyle}>SAFETY CARD TYPE</label>
            {/* Card colours match the physical ROAM safety cards, so they keep their own colours. */}
            <div style={{ display: "flex", gap: "4px" }}>
              <button type="button" onClick={() => {setCardType("Design"); removeHighlight('cardType');}} style={{ ...btnStyle, flex: 1, padding: "8px", backgroundColor: cardType === "Design" ? "#F3C200" : colors.input_bg, borderColor: cardType === "Design" ? "#F3C200" : colors.border, color: cardType === "Design" ? "#2E2E2E" : colors.text }}>Design</button>
              <button type="button" onClick={() => {setCardType("Field"); removeHighlight('cardType');}} style={{ ...btnStyle, flex: 1, padding: "8px", backgroundColor: cardType === "Field" ? "#1A7F37" : colors.input_bg, borderColor: cardType === "Field" ? "#1A7F37" : colors.border, color: cardType === "Field" ? "white" : colors.text }}>Field</button>
              <button type="button" onClick={() => {setCardType("Office"); removeHighlight('cardType');}} style={{ ...btnStyle, flex: 1, padding: "8px", backgroundColor: cardType === "Office" ? "#0D8BFF" : colors.input_bg, borderColor: cardType === "Office" ? "#0D8BFF" : colors.border, color: cardType === "Office" ? "white" : colors.text }}>Office</button>
            </div>
          </div>
          </div>
        </div>

    <div style={{ position: "relative" }} onMouseEnter={() => !isActivated && setShowSubmitTooltip(true)} onMouseLeave={() => setShowSubmitTooltip(false)}>
    {showSubmitTooltip && !isActivated && <div style={{ position: "absolute", bottom: "100%", left: "50%", transform: "translateX(-50%)", marginBottom: "6px", padding: "6px 12px", backgroundColor: colors.surface, border: `1px solid ${colors.border}`, borderRadius: "4px", fontSize: "11px", color: colors.text_muted, whiteSpace: "nowrap", zIndex: 100, pointerEvents: "none" }}>Connect to ROAM (status icon, top right) to enable submissions</div>}
    <button
      type="submit"
      disabled={!isSubmitting && !isActivated}
      title={isSubmitting ? "Click to cancel this submission" : undefined}
      style={{
        padding: "12px 14px",
        width: "100%",
        minHeight: "45px",
        backgroundColor: isSubmitting ? colors.primary : ((isActivated && isFormValid()) ? colors.primary : colors.locked_bg),
        color: isSubmitting || (isActivated && isFormValid()) ? "#FFFFFF" : colors.text_muted,
        border: "none",
        borderRadius: "4px",
        fontWeight: "bold",
        fontSize: "15px",
        fontFamily: "inherit",
        cursor: isSubmitting || isActivated ? "pointer" : "not-allowed",
        display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
      }}
    >
      {isSubmitting ? (
        <>
          <SpinnerIcon />
          <span style={{ flex: 1, minWidth: 0, textAlign: "left", fontSize: "13px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{submitProgress || "Submitting..."}</span>
          <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "4px", border: "1px solid rgba(255,255,255,0.6)", flexShrink: 0 }}>Cancel</span>
        </>
      ) : "Submit Observation"}
    </button>
    </div>
        {missingFields.length > 0 && (
          <div role="alert" style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: colors.error_red, marginTop: "-8px" }}>
            <AlertIcon size={14} />
            Fill in the {missingFields.length} highlighted field{missingFields.length === 1 ? "" : "s"} to submit.
          </div>
        )}
      </form>
    </div>
    </div>
  );
}
