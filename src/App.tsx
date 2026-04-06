import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import hatchLogo from "../hatch_logo.png";

interface Message {
  role: 'user' | 'ai';
  content: string;
}

export default function App() {
  const [status, setStatus] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [recognition, setRecognition] = useState<SpeechRecognition | null>(null);
  
  // Chat State
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isApiKeyValid, setIsApiKeyValid] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // API Key State
  const [apiKey, setApiKey] = useState("");

  // Form State
  const [project] = useState("Hatch Global (Project View)");
  const [office] = useState("Johannesburg");
  const [address] = useState("58 Emerald Parkway Road, Greenstone Hill");
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
  const [category] = useState("");
  const [cardType, setCardType] = useState("Field");

  const [isProjectLocked, setIsProjectLocked] = useState(false);
  const [isOfficeLocked, setIsOfficeLocked] = useState(false);
  const [isAddressLocked, setIsAddressLocked] = useState(false);

  // Dropdown state
  const [projectSearch, setProjectSearch] = useState("");
  const [officeSearch, setOfficeSearch] = useState("");
  const [addressSearch, setAddressSearch] = useState("");
  const [categorySearch, setCategorySearch] = useState("");

  const colors = {
    bg: "#FAFAFA", surface: "#F0F0F0", border: "#BFBFBF", text: "#2E2E2E", 
    text_muted: "#595959", primary: "#425563", primary_hover: "#2F3C46", 
    input_bg: "#FFFFFF", input_text: "#2E2E2E", orange: "#E84A37"
  };

  // Initialize speech recognition
  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      const recognitionInstance = new SpeechRecognition();
      recognitionInstance.continuous = true;
      recognitionInstance.interimResults = false;
      recognitionInstance.lang = 'en-US';

      recognitionInstance.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((result: any) => result[0])
          .map((result: any) => result.transcript)
          .join('');
        setChatInput(prev => (prev.trim() + ' ' + transcript).trim());
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

  const handleSaveApiKey = async () => {
    setStatus("Validating API key...");
    try {
      const result = await invoke<string>("store_api_key", { key: apiKey });
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
    
    const userMsg = chatInput;
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setChatInput("");
    setIsAiLoading(true);

    try {
      const response = await invoke<string>("chat_with_ai", { prompt: userMsg });
      
      // Check if the response contains JSON to populate the form
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[0]);
          if (data.project !== undefined && data.project !== "") setProjectSearch(data.project);
          if (data.office !== undefined) setOfficeSearch(data.office);
          if (data.address !== undefined) setAddressSearch(data.address);
          if (data.exactLoc !== undefined) setExactLoc(data.exactLoc);
          
          // AI returns dd MMMM yyyy, need to convert back to YYYY-MM-DD for <input type="date">
          if (data.date !== undefined) {
            try {
              const d = new Date(data.date);
              if (!isNaN(d.getTime())) {
                setDate(d.toISOString().split('T')[0]);
              }
            } catch (e) {
              console.error("Failed to parse date from AI:", data.date);
            }
          }
          
          if (data.time !== undefined) setTime(data.time);
          if (data.isContractor !== undefined) setIsContractor(data.isContractor === "Yes");
          if (data.isWorkHours !== undefined) setIsWorkHours(data.isWorkHours === "Yes");
          if (data.obsType !== undefined) setObsType(data.obsType);
          if (data.obsSafe !== undefined) setObsSafe(data.obsSafe);
          if (data.officeLoc !== undefined) setOfficeLoc(data.officeLoc);
          if (data.details !== undefined) setDetails(data.details);
          if (data.action !== undefined) setAction(data.action);
          if (data.category !== undefined) setCategorySearch(data.category);
          if (data.cardType !== undefined) setCardType(data.cardType);

          // Only show completion message if no error was reported by AI
          if (data.error) {
            setMessages(prev => [...prev, { role: 'ai', content: data.error }]);
            setIsAiLoading(false);
            return;
          }

          // Remove the JSON block and the specific intro text from the displayed message
          let cleanMessage = response.replace(jsonMatch[0], "").trim();
          cleanMessage = cleanMessage.replace("Based on your description, here's the extracted safety observation details:", "").trim();
          // Also check for the "Thank you..." phrase which is our completion signal
          setMessages(prev => [...prev, { role: 'ai', content: cleanMessage }]);
        } catch (e) {
          setMessages(prev => [...prev, { role: 'ai', content: response }]);
        }
      } else {
        setMessages(prev => [...prev, { role: 'ai', content: response }]);
      }
    } catch (error) {
      setMessages(prev => [...prev, { role: 'ai', content: `Error: ${error}` }]);
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleStartRecording = () => {
    if (!recognition) {
      setStatus("Speech recognition not supported in this browser.");
      return;
    }
    if (isRecording) {
      recognition.stop();
    } else {
      try {
        recognition.start();
        setIsRecording(true);
      } catch (err) {
        console.error("Failed to start recognition:", err);
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

  const handleSetToday = () => setDate(new Date().toISOString().split("T")[0]);
  const handleSetNow = () => {
    const now = new Date();
    setTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = { project, office, address, exactLoc, date: formatDateStr(date), time, isContractor, isWorkHours, obsType, obsSafe, officeLoc, details, action, category, cardType };
      const result = await invoke<string>("submit_observation", { payload: JSON.stringify(payload) });
      setStatus(result);
    } catch (error) {
      setStatus(`Error: ${error}`);
    }
  };

  const inputStyle = { width: "100%", padding: "6px 8px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.input_text, fontFamily: "inherit", boxSizing: "border-box" as const };
  const labelStyle = { fontSize: "11px", fontWeight: "bold", color: colors.text, marginBottom: "2px", display: "block" };
  const btnStyle = { padding: "6px 10px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, fontWeight: "bold", color: colors.text, fontSize: "11px", cursor: "pointer" };

  return (
    <div style={{ backgroundColor: colors.bg, color: colors.text, fontFamily: "'Source Sans Pro', Arial, sans-serif", padding: "16px", minHeight: "100vh" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <img src={hatchLogo} alt="HATCH" style={{ height: "28px" }} />
        <div style={{ fontSize: "15px", fontWeight: "bold" }}>Roam Observation Logger</div>
      </div>

      {/* Settings */}
      <div style={{ marginBottom: "16px", padding: "10px", backgroundColor: "white", border: `1px solid ${colors.border}`, borderRadius: "8px" }}>
        <label style={labelStyle}>GROQ API KEY</label>
        <div style={{ display: "flex", gap: "8px" }}>
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Enter API Key" style={inputStyle} />
          <button onClick={handleSaveApiKey} style={btnStyle}>Save Key</button>
        </div>
      </div>

      {/* Chat Interface */}
      <div style={{ marginBottom: "24px", border: `1px solid ${colors.border}`, borderRadius: "8px", overflow: "hidden", backgroundColor: "white", opacity: isApiKeyValid ? 1 : 0.6 }}>
        <div style={{ padding: "10px", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, fontWeight: "bold", fontSize: "12px", display: "flex", justifyContent: "space-between" }}>
          <span>AI Copilot</span>
          {!isApiKeyValid && <span style={{ color: colors.orange, fontSize: "10px" }}>Connect API Key to enable chat</span>}
        </div>
        <div style={{ height: "200px", overflowY: "auto", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {messages.map((msg, i) => (
            <div key={i} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', backgroundColor: msg.role === 'user' ? colors.primary : colors.surface, color: msg.role === 'user' ? 'white' : colors.text, padding: "6px 10px", borderRadius: "8px", fontSize: "13px", maxWidth: "80%" }}>
              {msg.content}
            </div>
          ))}
          {isAiLoading && <div style={{ fontSize: "12px", color: colors.text_muted }}>AI is thinking...</div>}
          <div ref={chatEndRef} />
        </div>
        <div style={{ padding: "10px", borderTop: `1px solid ${colors.border}`, display: "flex", gap: "8px" }}>
          <input 
            value={chatInput} 
            onChange={e => setChatInput(e.target.value)} 
            placeholder={isApiKeyValid ? "Provide details about your observation..." : "API Key required"} 
            style={{ ...inputStyle, backgroundColor: isApiKeyValid ? colors.input_bg : "#F5F5F5" }}
            onKeyDown={e => e.key === 'Enter' && isApiKeyValid && handleSendMessage()}
            disabled={!isApiKeyValid}
          />
          <button onClick={handleStartRecording} disabled={!isApiKeyValid} style={{ ...btnStyle, backgroundColor: isRecording ? colors.orange : colors.surface, cursor: isApiKeyValid ? "pointer" : "not-allowed" }}>🎤</button>
          <button onClick={handleSendMessage} disabled={!isApiKeyValid} style={{ ...btnStyle, backgroundColor: colors.primary, color: "white", cursor: isApiKeyValid ? "pointer" : "not-allowed", opacity: isApiKeyValid ? 1 : 0.5 }}>Send</button>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "8px", alignItems: "center" }}>
          <label style={labelStyle}>PROJECT</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <input value={isProjectLocked ? project : projectSearch || project} onChange={e => setProjectSearch(e.target.value)} disabled={isProjectLocked} style={{ ...inputStyle, backgroundColor: isProjectLocked ? "#E0E0E0" : colors.input_bg }} />
            <button type="button" onClick={() => setIsProjectLocked(!isProjectLocked)} style={btnStyle}>{isProjectLocked ? "Unlock" : "Lock"}</button>
          </div>
          
          <label style={labelStyle}>OFFICE</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <input value={isOfficeLocked ? office : officeSearch || office} onChange={e => setOfficeSearch(e.target.value)} disabled={isOfficeLocked} style={{ ...inputStyle, backgroundColor: isOfficeLocked ? "#E0E0E0" : colors.input_bg }} />
            <button type="button" onClick={() => setIsOfficeLocked(!isOfficeLocked)} style={btnStyle}>{isOfficeLocked ? "Unlock" : "Lock"}</button>
          </div>
          
          <label style={labelStyle}>ADDRESS</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <input value={isAddressLocked ? address : addressSearch || address} onChange={e => setAddressSearch(e.target.value)} disabled={isAddressLocked} style={{ ...inputStyle, backgroundColor: isAddressLocked ? "#E0E0E0" : colors.input_bg }} />
            <button type="button" onClick={() => setIsAddressLocked(!isAddressLocked)} style={btnStyle}>{isAddressLocked ? "Unlock" : "Lock"}</button>
          </div>
          
          <label style={labelStyle}>LOCATION</label>
          <input value={exactLoc} onChange={e => setExactLoc(e.target.value)} placeholder="Exact location" style={inputStyle} />
          
          <label style={labelStyle}>DATE</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
            <button type="button" onClick={handleSetToday} style={btnStyle}>Today</button>
          </div>
          
          <label style={labelStyle}>TIME</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <input type="time" value={time} onChange={e => setTime(e.target.value)} style={inputStyle} />
            <button type="button" onClick={handleSetNow} style={btnStyle} tabIndex={1}>Now</button>
          </div>
        </div>

        <div style={{ backgroundColor: colors.surface, borderRadius: "8px", padding: "12px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Was the work performed by a Contractor?</span>
            <div 
              onClick={() => setIsContractor(!isContractor)} 
              tabIndex={2}
              onKeyDown={(e) => e.key === 'Enter' && setIsContractor(!isContractor)}
              style={{ width: "50px", height: "28px", backgroundColor: isContractor ? colors.orange : "#8C8C8C", borderRadius: "14px", position: "relative", cursor: "pointer", display: "flex", alignItems: "center", padding: "0 6px", boxSizing: "border-box", justifyContent: isContractor ? "flex-start" : "flex-end", transition: "background-color 0.2s" }}
            >
              <span style={{ color: "white", fontSize: "10px", fontWeight: "bold" }}>{isContractor ? "Yes" : "No"}</span>
              <div style={{ width: "24px", height: "24px", backgroundColor: "white", borderRadius: "50%", position: "absolute", top: "2px", left: isContractor ? "24px" : "2px", transition: "left 0.2s" }} />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Was this observed during working hours?</span>
            <div 
              onClick={() => setIsWorkHours(!isWorkHours)} 
              tabIndex={3}
              onKeyDown={(e) => e.key === 'Enter' && setIsWorkHours(!isWorkHours)}
              style={{ width: "50px", height: "28px", backgroundColor: isWorkHours ? colors.orange : "#8C8C8C", borderRadius: "14px", position: "relative", cursor: "pointer", display: "flex", alignItems: "center", padding: "0 6px", boxSizing: "border-box", justifyContent: isWorkHours ? "flex-start" : "flex-end", transition: "background-color 0.2s" }}
            >
              <span style={{ color: "white", fontSize: "10px", fontWeight: "bold" }}>{isWorkHours ? "Yes" : "No"}</span>
              <div style={{ width: "24px", height: "24px", backgroundColor: "white", borderRadius: "50%", position: "absolute", top: "2px", left: isWorkHours ? "24px" : "2px", transition: "left 0.2s" }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Behaviour", "Condition"].map((t, idx) => <button key={t} type="button" tabIndex={idx === 0 ? 4 : undefined} onClick={() => setObsType(t)} style={{ flex: 1, padding: "4px", backgroundColor: obsType === t ? colors.input_bg : "transparent", border: `1px solid ${colors.border}`, borderRadius: "4px", fontWeight: "bold", fontSize: "11px", cursor: "pointer" }}>{t}</button>)}
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Safe", "At Risk"].map(t => <button key={t} type="button" onClick={() => setObsSafe(t)} style={{ flex: 1, padding: "4px", backgroundColor: obsSafe === t ? colors.input_bg : "transparent", border: `1px solid ${colors.border}`, borderRadius: "4px", fontWeight: "bold", fontSize: "11px", cursor: "pointer" }}>{t}</button>)}
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Hatch office", "Home office", "Site/Client"].map(t => <button key={t} type="button" onClick={() => setOfficeLoc(t)} style={{ flex: 1, padding: "4px", backgroundColor: officeLoc === t ? colors.input_bg : "transparent", border: `1px solid ${colors.border}`, borderRadius: "4px", fontWeight: "bold", fontSize: "11px", cursor: "pointer" }}>{t}</button>)}
          </div>
        </div>

        <div>
          <label style={labelStyle}>OBSERVATION DETAILS</label>
          <textarea value={details} onChange={e => setDetails(e.target.value)} placeholder="Enter observation details..." style={{ ...inputStyle, height: "60px", resize: "none" }} />
        </div>

        <div>
          <label style={labelStyle}>IMMEDIATE ACTION</label>
          <textarea value={action} onChange={e => setAction(e.target.value)} placeholder="Enter immediate action taken..." style={{ ...inputStyle, height: "60px", resize: "none" }} />
        </div>

        <div>
          <label style={labelStyle}>CATEGORY</label>
          <input value={categorySearch || category} onChange={e => setCategorySearch(e.target.value)} placeholder="Search or select category..." style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>SAFETY CARD TYPE</label>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" onClick={() => setCardType("Design")} style={{ ...btnStyle, flex: 1, backgroundColor: cardType === "Design" ? "#F3C200" : colors.surface }}>Design</button>
            <button type="button" onClick={() => setCardType("Field")} style={{ ...btnStyle, flex: 1, backgroundColor: cardType === "Field" ? "#1A7F37" : colors.surface, color: cardType === "Field" ? "white" : colors.text }}>Field</button>
            <button type="button" onClick={() => setCardType("Office")} style={{ ...btnStyle, flex: 1, backgroundColor: cardType === "Office" ? "#0D8BFF" : colors.surface, color: cardType === "Office" ? "white" : colors.text }}>Office</button>
          </div>
        </div>

        <button type="submit" style={{ padding: "12px 20px", backgroundColor: colors.primary, color: "#FFFFFF", border: "none", borderRadius: "8px", fontWeight: "bold", fontSize: "14px", cursor: "pointer", marginTop: "10px" }}>
          Submit Observation
        </button>
        {status && <div style={{ color: colors.primary, fontWeight: "bold", textAlign: "center" }}>{status}</div>}
      </form>
    </div>
  );
}
