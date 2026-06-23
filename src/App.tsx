import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

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

export default function App() {
  const [status, setStatus] = useState("");
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
            const result = await invoke<string>("store_api_key", { key: savedKey });
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
      const remaining = Math.max(0, 1000 - elapsed);
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
      setStatus("API key cleared.");
    });
    return () => {
      unlisten.then(f => f());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("activation-debug", (event) => {
      setStatus(event.payload);
      console.log("Activation debug:", event.payload);
    });
    const unlistenProgress = listen<string>("submission-progress", (event) => {
      setStatus(event.payload);
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
        setStatus("First-time setup: click Connect to authenticate with ROAM.");
        return;
      }
      setIsActivating(true);
      setStatus("Checking ROAM connection...");
      try {
        await invoke<boolean>("ping_roam");
        setIsActivated(true);
        setActivationError(false);
        localStorage.setItem("roam_activated", "true");
        setStatus("Connected to ROAM.");
      } catch (e) {
        setActivationError(true);
        setIsActivated(false);
        localStorage.removeItem("roam_activated");
        setStatus(`Connection check failed: ${e}`);
      } finally {
        setIsActivating(false);
      }
    } catch (e) {
      console.warn("autoConnectOnLaunch error:", e);
    }
  };

  useEffect(() => {
    autoConnectOnLaunch();
  }, []);

  // Auto-update check on app launch. Silent on failure - if GitHub is
  // unreachable or there is no update available, the user sees nothing
  // and uses the app normally. If an update IS available, the .msi is
  // downloaded, signature-verified against the embedded public key,
  // installed, and the app relaunches itself on the new version.
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);

  // Runtime-loaded project/city/street lists. Default to empty until fetched
  // from SharePoint. The fetch happens in a useEffect below.
  const [projectsList, setProjectsList] = useState<string[]>(PROJECTS_LIST_DEFAULT);
  const [citiesList, setCitiesList] = useState<string[]>(CITIES_LIST_DEFAULT);
  const [streetsList, setStreetsList] = useState<string[]>(STREETS_LIST_DEFAULT);
  const [dataAgeDays, setDataAgeDays] = useState<number | null>(null);
  const [dataFromCache, setDataFromCache] = useState<boolean>(false);

  useEffect(() => {
    (async () => {
      try {
        const result = await invoke<ProjectDataResult>("fetch_project_data");
        if (result?.data?.projects) {
          setProjectsList(result.data.projects);
          setCitiesList(result.data.cities);
          setStreetsList(result.data.streets);
          setDataAgeDays(result.ageDays);
          setDataFromCache(result.fromCache);
          if (result.fromCache && (result.ageDays ?? 0) > 7) {
            setStatus(`Project list last updated ${Math.round(result.ageDays ?? 0)} days ago. Connect to a Hatch network to refresh.`);
          }
        } else {
          // Result came back malformed - degrade gracefully
          console.warn("Project data result was malformed:", result);
          setStatus("Project list unavailable. Some dropdowns will be empty until next launch.");
        }
      } catch (e) {
        // Fetch failed entirely (no network, no cache, SharePoint auth, etc).
        // The UI still renders - dropdowns will be empty but the rest works.
        console.warn("Project data load failed:", e);
        setStatus(`Project list unavailable: ${e}. Dropdowns will be empty - the rest of the app still works.`);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const update = await check();
        if (!update) return;
        setStatus(`Update available: v${update.version}. Downloading...`);
        let downloaded = 0;
        let total = 0;
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") {
            total = event.data.contentLength ?? 0;
            setUpdateProgress(0);
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            if (total > 0) {
              const pct = Math.round((downloaded / total) * 100);
              setUpdateProgress(pct);
              setStatus(`Downloading update v${update.version}... ${pct}%`);
            }
          } else if (event.event === "Finished") {
            setUpdateProgress(100);
            setStatus(`Update v${update.version} installed. Restarting...`);
          }
        });
        await relaunch();
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

  // System dark mode detection
  const [isDark, setIsDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const colors = isDark ? {
    bg: "#1A1A1A", surface: "#2A2A2A", border: "#4A4A4A", text: "#E0E0E0",
    text_muted: "#A0A0A0", primary: "#5B7A8C", primary_hover: "#6E8FA3",
    input_bg: "#2E2E2E", input_text: "#E0E0E0", orange: "#E84A37",
    sage: "#2E3B2A",
    card_bg: "#242424", modal_bg: "#2E2E2E", modal_overlay: "rgba(0,0,0,0.7)",
    toggle_off: "#555555", locked_bg: "#3A3A3A", debug_bg: "#2E2800",
    debug_border: "#5A4800", debug_text: "#D4A800", error_red: "#FF6B6B"
  } : {
    bg: "#FAFAFA", surface: "#F0F0F0", border: "#BFBFBF", text: "#2E2E2E",
    text_muted: "#595959", primary: "#425563", primary_hover: "#2F3C46",
    input_bg: "#FFFFFF", input_text: "#2E2E2E", orange: "#E84A37",
    sage: "#E0EADD",
    card_bg: "#FFFFFF", modal_bg: "#FFFFFF", modal_overlay: "rgba(0,0,0,0.5)",
    toggle_off: "#8C8C8C", locked_bg: "#E0E0E0", debug_bg: "#FFFBE6",
    debug_border: "#FFE58F", debug_text: "#856404", error_red: "red"
  };

  // Initialize speech recognition
  useEffect(() => {
    const WindowSpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (WindowSpeechRecognition) {
      const recognitionInstance = new WindowSpeechRecognition() as SpeechRecognition;
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
      setStatus("API key cleared.");
    } catch (error) {
      setStatus(`Error clearing key: ${error}`);
    }
  };

  const handleSendFeedback = async () => {
    try {
      await invoke("send_feedback");
    } catch (error) {
      console.error("Failed to send feedback", error);
    }
  };

  const handleActivate = async () => {
    setIsActivating(true);
    setActivationError(false);
    try {
      // If the user has already activated once, the Connect button is just a
      // re-ping - fast, no browser window. If they have not, fall through to
      // the full visible interactive activation flow.
      const hasMarker = await invoke<boolean>("has_activation_marker");
      if (hasMarker) {
        setStatus("Checking ROAM connection...");
        await invoke<boolean>("ping_roam");
        setIsActivated(true);
        setActivationError(false);
        localStorage.setItem("roam_activated", "true");
        setStatus("Connected to ROAM.");
        return;
      }
      setStatus("First-time setup: a browser window will open for authentication...");
      await invoke("activate_handshake");
      setIsActivated(true);
      setActivationError(false);
      localStorage.setItem("roam_activated", "true");
      refreshActivationAge();
      setStatus("Connected to ROAM successfully.");
    } catch (error) {
      setActivationError(true);
      setIsActivated(false);
      localStorage.removeItem("roam_activated");
      setStatus(`Connection failed: ${error}`);
    } finally {
      setIsActivating(false);
    }
  };

  const handleSaveApiKey = async () => {
    const keyToValidate = apiKey.trim();
    if (!keyToValidate) {
      setStatus("Please enter an API key.");
      return;
    }

    setStatus("Validating API key...");

    const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI_IPC__;
    if (!isTauri) {
      setStatus("Error: Tauri API not available. Are you running in a browser instead of the app?");
      return;
    }

    try {
      const result = await invoke<string>("store_api_key", { key: keyToValidate });
      setStatus(result);
      setIsApiKeyValid(true);
      setApiKey("");
    } catch (error) {
      setStatus(`${error}`);
      setIsApiKeyValid(false);
    }
  };

  const handleSendMessage = async () => {
    if (!chatInput.trim()) return;

    // Stop voice listening the moment the user sends the message. If the
    // microphone is still on it would keep capturing audio while the AI is
    // processing and stream stale text into chatInput - confusing and noisy.
    if (isRecording && recognition) {
      try { recognition.stop(); } catch (e) { /* already stopped */ }
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
      setStatus("Speech recognition not supported.");
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
        recognition.start();
        setIsRecording(true);
        
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = setTimeout(() => {
          if (recognition) {
            try { recognition.stop(); } catch(e) {}
          }
        }, 8000); // Increased initial timeout
      } catch (err) {
        console.error("Failed to start recognition:", err);
        setIsRecording(false);
        setStatus("Could not start microphone. Check permissions.");
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
      setStatus("Cancellation requested...");
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
        setStatus("ROAM connection appears stale. Auto-reconnecting...");
        try {
          await invoke("activate_handshake");
          await refreshActivationAge();
          setIsActivated(true);
          setActivationError(false);
          localStorage.setItem("roam_activated", "true");
          setStatus("Reconnected. Retrying submission...");
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
      setStatus("Error: Please fill in all required fields before submitting.");
      return;
    }
    const payload = { project, office, address, exactLoc, date: formatDateStr(date), time, isContractor, isWorkHours, obsType, obsSafe, officeLoc, details, action, category, cardType };
    setStatus("Starting submission...");
    setIsSubmitting(true);

    try {
      const result = await submitObservationWithAutoReconnect(
        JSON.stringify(payload),
        !isDebugVisible
      );
      setStatus(result);
    } catch (error: any) {
      const errStr = `${error}`;
      setStatus(errStr);
      // If we still could not reach ROAM after the auto-reconnect attempt,
      // mark the connection as broken so the user sees the Connect button
      // light up again.
      if (errStr.includes("Could not reach the ROAM website") || errStr.includes("Auto-reconnect also failed")) {
        setIsActivated(false);
        localStorage.removeItem("roam_activated");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputStyle = { width: "100%", padding: "6px 8px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.input_text, fontFamily: "inherit", fontSize: "13.333px", boxSizing: "border-box" as const, userSelect: "text" as const };
  const labelStyle = { fontSize: "11px", fontWeight: "bold", color: colors.text, marginBottom: "2px", display: "block", userSelect: "none" as const };
  const btnStyle = { padding: "6px 10px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, fontWeight: "bold", color: colors.text, fontSize: "11px", cursor: "pointer" };



  return (
    <div style={{ backgroundColor: colors.bg, color: colors.text, fontFamily: "'Source Sans Pro', Arial, sans-serif", padding: "16px", minHeight: "100vh", userSelect: "none" }}>
          <style>{`
      @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
      .voice-blinker { animation: blink 1s linear infinite; color: ${colors.orange}; font-weight: bold; }
      html, body { background-color: ${colors.bg}; margin: 0; padding: 0; }
      input[type="password"]::-ms-reveal, input[type="password"]::-ms-clear { display: none; }
      input[type="date"]::-webkit-calendar-picker-indicator { filter: ${isDark ? 'invert(1)' : 'none'}; }
      input[type="time"]::-webkit-calendar-picker-indicator { filter: ${isDark ? 'invert(1)' : 'none'}; }
      ::-webkit-scrollbar { width: 8px; }
      ::-webkit-scrollbar-track { background: ${colors.bg}; }
      ::-webkit-scrollbar-thumb { background: ${colors.border}; border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: ${colors.text_muted}; }
    `}</style>
          {activationAgeHours !== null && activationAgeHours > 12 && (
        <div style={{ padding: "8px 12px", marginBottom: "12px", backgroundColor: colors.debug_bg, border: `1px solid ${colors.debug_border}`, borderRadius: "4px", fontSize: "12px", color: colors.debug_text, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <span>Last connected {Math.round(activationAgeHours)} hours ago - consider reconnecting before submitting.</span>
          <button onClick={() => { setActivationError(false); handleActivate(); }} disabled={isActivating} style={{ ...btnStyle, fontSize: "10px", padding: "3px 8px", whiteSpace: "nowrap" }}>Reconnect now</button>
        </div>
      )}

      {/* Header */}
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
    <div style={{ fontSize: "15px", fontWeight: "bold" }}>Roam Observation Logger</div>
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <button
        onClick={(!isActivated && !isActivating) || activationError ? () => { setActivationError(false); handleActivate(); } : undefined}
        disabled={isActivated || (isActivating && !activationError)}
        style={{ ...btnStyle, backgroundColor: activationError ? colors.error_red : (isActivated ? "#1A7F37" : colors.surface), color: activationError || isActivated ? "white" : colors.text, border: `1px solid ${activationError ? colors.error_red : (isActivated ? "#1A7F37" : colors.border)}`, cursor: isActivated ? "default" : (isActivating ? "wait" : "pointer"), opacity: isActivating && !activationError ? 0.6 : 1 }}
      >
        {isActivating && !activationError ? "Connecting..." : (activationError ? "Connection Error" : (isActivated ? "Connected" : "Connect"))}
      </button>
      <div style={{ position: "relative" }}>
        <button onClick={() => setShowVersion(!showVersion)} title="App info" style={{ ...btnStyle, borderRadius: "50%", width: "24px", height: "24px", padding: "0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", backgroundColor: colors.surface }}>?</button>
        {showVersion && <div style={{ position: "absolute", top: "100%", right: 0, marginTop: "4px", padding: "8px 12px", backgroundColor: colors.surface, border: `1px solid ${colors.border}`, borderRadius: "6px", fontSize: "11px", color: colors.text_muted, whiteSpace: "nowrap", zIndex: 100, display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-start" }}>
          <span>Roam Observation Logger v0.4.5{updateProgress !== null ? ` (updating ${updateProgress}%)` : ""}</span>
          <button onClick={(e) => { e.stopPropagation(); handleSendFeedback(); setShowVersion(false); }} style={{ ...btnStyle, padding: "3px 8px", fontSize: "10px", backgroundColor: colors.bg, width: "100%" }}>Send Feedback</button>
        </div>}
      </div>
    </div>
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
                style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", border: "none", background: "none", cursor: "pointer", fontSize: "10px", opacity: 0.8, color: colors.primary, fontWeight: "bold" }}
              >
                {showKey ? "HIDE" : "SHOW"}
              </button>
            </div>
            <button onClick={handleSaveApiKey} style={btnStyle}>Save Key</button>
            <button type="button" onClick={() => setShowKeyModal(true)} style={{ ...btnStyle, backgroundColor: colors.surface }}>Get Key</button>
          </div>
          <div style={{ fontSize: "10px", color: colors.text_muted }}>
            A valid API key is required for ROAM AI features.
          </div>
        </div>
      )}

      {/* Get Key Modal */}
      {showKeyModal && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.modal_overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
          <div style={{ backgroundColor: colors.modal_bg, color: colors.text, padding: "24px", borderRadius: "12px", maxWidth: "400px", textAlign: "center", boxShadow: "0 4px 20px rgba(0,0,0,0.3)" }}>
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
    <div style={{ fontSize: "12px", fontWeight: "bold", color: colors.debug_text }}>DEBUG SETTINGS</div>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "11px" }}>
            <input type="checkbox" checked={isDebugVisible} onChange={e => setIsDebugVisible(e.target.checked)} />
            Show browser and automation steps (Not Headless)
          </label>
          <button 
            type="button" 
            onClick={handleClearApiKey} 
            style={{ ...btnStyle, backgroundColor: colors.card_bg, borderColor: colors.orange, color: colors.orange, width: "fit-content" }}
          >
            Clear API Key
          </button>
          <button 
            type="button" 
            onClick={() => {
              setIsActivated(false);
              localStorage.removeItem("roam_activated");
              setActivationError(false);
              setStatus("Activation cleared. Click Activate to re-test.");
            }} 
            style={{ ...btnStyle, backgroundColor: colors.card_bg, borderColor: colors.debug_text, color: colors.debug_text, width: "fit-content" }}
          >
            Clear Activation
          </button>
        </div>
      )}

      {/* Chat Interface */}
      <div style={{ marginBottom: "24px", border: `1px solid ${colors.border}`, borderRadius: "8px", overflow: "hidden", backgroundColor: colors.card_bg, opacity: isApiKeyValid ? 1 : 0.6 }}>
        <div style={{ padding: "6px 10px", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, fontWeight: "bold", fontSize: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span>ROAM AI</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {!isApiKeyValid && <span style={{ color: colors.orange, fontSize: "10px" }}>Connect API Key to enable chat</span>}
            <button 
              onClick={handleNewChat} 
              style={{ ...btnStyle, padding: "4px 8px", fontSize: "10px", backgroundColor: colors.bg }}
              disabled={!isApiKeyValid}
            >
              New chat
            </button>
          </div>
        </div>
        <div style={{ height: "200px", overflowY: "auto", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {messages.map((msg, i) => (
            <div key={i} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', backgroundColor: msg.role === 'user' ? colors.primary : colors.surface, color: msg.role === 'user' ? 'white' : colors.text, padding: "6px 10px", borderRadius: "8px", fontSize: "13px", maxWidth: "80%", userSelect: "text" }}>
              {msg.content}
            </div>
          ))}
          {isAiLoading && <div style={{ fontSize: "12px", color: colors.text_muted }}>AI is thinking{loadingDots}</div>}
          <div ref={chatEndRef} />
        </div>
        <div style={{ padding: "10px", borderTop: `1px solid ${colors.border}`, display: "flex", gap: "8px", alignItems: "flex-end" }}>
          <textarea 
            value={chatInput} 
            onChange={e => {
              setChatInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = e.target.scrollHeight + 'px';
            }} 
            placeholder={isRecording ? "Voice input in progress..." : (isApiKeyValid ? "Provide details about your observation..." : "API Key required")} 
            style={{ 
              ...inputStyle, 
              backgroundColor: isApiKeyValid ? colors.input_bg : (isDark ? "#252525" : "#F5F5F5"),
              height: "32px",
              minHeight: "32px",
              maxHeight: "300px",
              resize: "none",
              paddingTop: "6px",
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
          <button onClick={handleStartRecording} disabled={!isApiKeyValid} style={{ ...btnStyle, height: "32px", backgroundColor: isRecording ? colors.orange : colors.surface, cursor: isApiKeyValid ? "pointer" : "not-allowed", display: "flex", alignItems: "center", gap: "4px", whiteSpace: "nowrap" }}><span style={{ fontSize: "10px" }}>Voice Log</span>🎤</button>
          <button onClick={() => { handleSendMessage(); const area = document.querySelector('textarea'); if(area) area.style.height='32px'; }} disabled={!isApiKeyValid || !isActivated} style={{ ...btnStyle, height: "32px", backgroundColor: colors.primary, color: "white", cursor: (isApiKeyValid && isActivated) ? "pointer" : "not-allowed", opacity: (isApiKeyValid && isActivated) ? 1 : 0.5 }}>Send</button>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "8px", alignItems: "center" }}>
          <label style={labelStyle}>PROJECT</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <div style={{ width: "100%", position: "relative" }}>
              <input
                list="projects-list"
                value={project}
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
            <button type="button" onClick={() => setIsProjectLocked(!isProjectLocked)} style={{ ...btnStyle, width: "60px" }}>{isProjectLocked ? "Unlock" : "Lock"}</button>
          </div>
          
          <label style={labelStyle}>OFFICE</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <div style={{ width: "100%", position: "relative" }}>
              <input
                list="cities-list"
                value={office}
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
            <button type="button" onClick={() => setIsOfficeLocked(!isOfficeLocked)} style={{ ...btnStyle, width: "60px" }}>{isOfficeLocked ? "Unlock" : "Lock"}</button>
          </div>
          
          <label style={labelStyle}>ADDRESS</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <div style={{ width: "100%", position: "relative" }}>
              <input
                list="streets-list"
                value={address}
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
            <button type="button" onClick={() => setIsAddressLocked(!isAddressLocked)} style={{ ...btnStyle, width: "60px" }}>{isAddressLocked ? "Unlock" : "Lock"}</button>
          </div>
          
          <label style={labelStyle}>LOCATION</label>
          <input value={exactLoc} onChange={e => {setExactLoc(e.target.value); removeHighlight('exactLoc');}} placeholder="Exact location" style={{...inputStyle, backgroundColor: highlightedFields.has('exactLoc') ? colors.sage : colors.input_bg}} />
          
          <label style={labelStyle}>DATE</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <input 
              type="date" 
              value={date} 
              onChange={e => {setDate(e.target.value); removeHighlight('date');}} 
              style={{
                ...inputStyle, 
                backgroundColor: highlightedFields.has('date') ? colors.sage : colors.input_bg,
                color: date && new Date(date).setHours(0,0,0,0) > new Date().setHours(0,0,0,0) ? colors.orange : colors.input_text
              }} 
            />
            <button type="button" onClick={handleSetToday} style={{ ...btnStyle, width: "60px" }}>Today</button>
          </div>
          
          <label style={labelStyle}>TIME</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <input type="time" value={time} onChange={e => {setTime(e.target.value); removeHighlight('time');}} style={{...inputStyle, backgroundColor: highlightedFields.has('time') ? colors.sage : colors.input_bg}} />
            <button type="button" onClick={handleSetNow} style={{ ...btnStyle, width: "60px" }} tabIndex={1}>Now</button>
          </div>
        </div>

        <div style={{ backgroundColor: colors.surface, borderRadius: "8px", padding: "12px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Was the work performed by a Contractor?</span>
            <div 
              onClick={() => {setIsContractor(!isContractor); removeHighlight('isContractor');}} 
              tabIndex={2}
              onKeyDown={(e) => e.key === 'Enter' && (setIsContractor(!isContractor), removeHighlight('isContractor'))}
              style={{ width: "50px", height: "28px", backgroundColor: highlightedFields.has('isContractor') ? colors.sage : (isContractor ? colors.orange : colors.toggle_off), borderRadius: "14px", position: "relative", cursor: "pointer", display: "flex", alignItems: "center", padding: "0 6px", boxSizing: "border-box", justifyContent: isContractor ? "flex-start" : "flex-end", transition: "background-color 0.2s" }}
            >
              <span style={{ color: highlightedFields.has('isContractor') ? "black" : "white", fontSize: "10px", fontWeight: "bold" }}>{isContractor ? "Yes" : "No"}</span>
              <div style={{ width: "24px", height: "24px", backgroundColor: "white", borderRadius: "50%", position: "absolute", top: "2px", left: isContractor ? "24px" : "2px", transition: "left 0.2s" }} />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Was this observed during working hours?</span>
            <div 
              onClick={() => {setIsWorkHours(!isWorkHours); removeHighlight('isWorkHours');}} 
              tabIndex={3}
              onKeyDown={(e) => e.key === 'Enter' && (setIsWorkHours(!isWorkHours), removeHighlight('isWorkHours'))}
              style={{ width: "50px", height: "28px", backgroundColor: highlightedFields.has('isWorkHours') ? colors.sage : (isWorkHours ? colors.orange : colors.toggle_off), borderRadius: "14px", position: "relative", cursor: "pointer", display: "flex", alignItems: "center", padding: "0 6px", boxSizing: "border-box", justifyContent: isWorkHours ? "flex-start" : "flex-end", transition: "background-color 0.2s" }}
            >
              <span style={{ color: highlightedFields.has('isWorkHours') ? "black" : "white", fontSize: "10px", fontWeight: "bold" }}>{isWorkHours ? "Yes" : "No"}</span>
              <div style={{ width: "24px", height: "24px", backgroundColor: "white", borderRadius: "50%", position: "absolute", top: "2px", left: isWorkHours ? "24px" : "2px", transition: "left 0.2s" }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Behaviour", "Condition"].map((t, idx) => <button key={t} type="button" tabIndex={idx === 0 ? 4 : undefined} onClick={() => {setObsType(t); removeHighlight('obsType');}} style={{ flex: 1, padding: "8px", backgroundColor: obsType === t ? (highlightedFields.has('obsType') ? colors.sage : colors.input_bg) : "transparent", border: `1px solid ${colors.border}`, borderRadius: "4px", fontWeight: "bold", fontSize: "11px", cursor: "pointer", color: colors.text }}>{t}</button>)}
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Safe", "At Risk"].map(t => <button key={t} type="button" onClick={() => {setObsSafe(t); removeHighlight('obsSafe');}} style={{ flex: 1, padding: "8px", backgroundColor: obsSafe === t ? (highlightedFields.has('obsSafe') ? colors.sage : colors.input_bg) : "transparent", border: `1px solid ${colors.border}`, borderRadius: "4px", fontWeight: "bold", fontSize: "11px", cursor: "pointer", color: colors.text }}>{t}</button>)}
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Hatch office", "Home office", "Site/Client"].map(t => <button key={t} type="button" onClick={() => {setOfficeLoc(t); removeHighlight('officeLoc');}} style={{ flex: 1, padding: "8px", backgroundColor: officeLoc === t ? (highlightedFields.has('officeLoc') ? colors.sage : colors.input_bg) : "transparent", border: `1px solid ${colors.border}`, borderRadius: "4px", fontWeight: "bold", fontSize: "11px", cursor: "pointer", color: colors.text }}>{t}</button>)}
          </div>
        </div>

        <div>
          <label style={labelStyle}>OBSERVATION DETAILS</label>
          <textarea value={details} onChange={e => {setDetails(e.target.value); removeHighlight('details');}} placeholder="Enter observation details..." style={{ ...inputStyle, height: "60px", resize: "none", backgroundColor: highlightedFields.has('details') ? colors.sage : colors.input_bg }} />
        </div>

        <div>
          <label style={labelStyle}>IMMEDIATE ACTION</label>
          <textarea value={action} onChange={e => {setAction(e.target.value); removeHighlight('action');}} placeholder="Enter immediate action taken..." style={{ ...inputStyle, height: "60px", resize: "none", backgroundColor: highlightedFields.has('action') ? colors.sage : colors.input_bg }} />
        </div>

        <div>
          <label style={labelStyle}>CATEGORY</label>
          <input
            list="categories-list"
            value={category}
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
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" onClick={() => {setCardType("Design"); removeHighlight('cardType');}} style={{ ...btnStyle, flex: 1, backgroundColor: cardType === "Design" ? "#F3C200" : colors.surface, color: cardType === "Design" ? "#2E2E2E" : colors.text }}>Design</button>
            <button type="button" onClick={() => {setCardType("Field"); removeHighlight('cardType');}} style={{ ...btnStyle, flex: 1, backgroundColor: cardType === "Field" ? "#1A7F37" : colors.surface, color: cardType === "Field" ? "white" : colors.text }}>Field</button>
            <button type="button" onClick={() => {setCardType("Office"); removeHighlight('cardType');}} style={{ ...btnStyle, flex: 1, backgroundColor: cardType === "Office" ? "#0D8BFF" : colors.surface, color: cardType === "Office" ? "white" : colors.text }}>Office</button>
          </div>
        </div>

    <div style={{ position: "relative" }} onMouseEnter={() => !isActivated && setShowSubmitTooltip(true)} onMouseLeave={() => setShowSubmitTooltip(false)}>
    {showSubmitTooltip && !isActivated && <div style={{ position: "absolute", bottom: "100%", left: "50%", transform: "translateX(-50%)", marginBottom: "6px", padding: "6px 12px", backgroundColor: colors.surface, border: `1px solid ${colors.border}`, borderRadius: "6px", fontSize: "11px", color: colors.text_muted, whiteSpace: "nowrap", zIndex: 100, pointerEvents: "none" }}>Click "Activate" to enable ROAM submissions</div>}
    <button
      type="submit"
      disabled={!isSubmitting && (!isFormValid() || !isActivated)}
      style={{
        padding: "12px 20px",
        width: "100%",
        backgroundColor: isSubmitting ? colors.orange : (!isActivated ? colors.border : (isFormValid() ? colors.primary : colors.border)),
        color: "#FFFFFF",
        border: "none",
        borderRadius: "8px",
        fontWeight: "bold",
        fontSize: "14px",
        cursor: (isSubmitting || (isFormValid() && isActivated)) ? "pointer" : "not-allowed",
        marginTop: "10px"
      }}
    >
      {isSubmitting ? "Cancel Submission" : "Submit Observation"}
    </button>
    </div>
        {status && <div style={{ color: colors.primary, fontWeight: "bold", textAlign: "center" }}>{status}</div>}
      </form>
    </div>
  );
}
