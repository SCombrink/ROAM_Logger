import { useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";

export default function App() {
  const [status, setStatus] = useState("");
  
  // Form State
  const [aiPrompt, setAiPrompt] = useState("");
  const [project, setProject] = useState("Hatch Global (Project View)");
  const [office, setOffice] = useState("Johannesburg");
  const [address, setAddress] = useState("58 Emerald Parkway Road, Greenstone Hill");
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

  const colors = {
    bg: "#FAFAFA", surface: "#F0F0F0", border: "#BFBFBF", text: "#2E2E2E", 
    text_muted: "#595959", primary: "#425563", primary_hover: "#2F3C46", 
    input_bg: "#FFFFFF", input_text: "#2E2E2E", orange: "#E84A37"
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = { project, office, address, exactLoc, date, time, isContractor, isWorkHours, obsType, obsSafe, officeLoc, details, action, category, cardType };
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
        <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 900, letterSpacing: "1px" }}>HATCH</h1>
        <div style={{ fontSize: "15px", fontWeight: "bold" }}>Roam Observation Logger</div>
      </div>

      {/* Top Buttons */}
      <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
        <button style={btnStyle}>Set current as default</button>
        <button style={btnStyle}>Use Default</button>
        <button style={{ ...btnStyle, borderColor: "#FFCECB", backgroundColor: "#FFEBED", color: "#CF222E" }}>Reset Form</button>
      </div>

      {/* AI Integration */}
      <div style={{ display: "flex", flexDirection: "column", marginBottom: "16px" }}>
        <textarea 
          value={aiPrompt} onChange={e => setAiPrompt(e.target.value)}
          placeholder="Describe your observation naturally or hit Start Recording..."
          style={{ ...inputStyle, borderBottom: "none", borderBottomLeftRadius: 0, borderBottomRightRadius: 0, height: "60px", fontSize: "14px", resize: "none" }}
        />
        <div style={{ display: "flex" }}>
          <button style={{ ...btnStyle, flex: 1, backgroundColor: colors.surface, borderTopLeftRadius: 0, borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRight: "none" }}>Start Recording</button>
          <button style={{ ...btnStyle, flex: 1, backgroundColor: colors.surface, borderTopLeftRadius: 0, borderTopRightRadius: 0, borderBottomLeftRadius: 0 }}>Submit Prompt</button>
        </div>
      </div>

      <div style={{ borderBottom: `1px solid ${colors.border}`, marginBottom: "12px" }} />

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {/* Grid Area */}
        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "8px", alignItems: "center" }}>
          <label style={labelStyle}>PROJECT</label>
          <input value={project} onChange={e => setProject(e.target.value)} style={inputStyle} />
          
          <label style={labelStyle}>OFFICE</label>
          <input value={office} onChange={e => setOffice(e.target.value)} style={inputStyle} />
          
          <label style={labelStyle}>ADDRESS</label>
          <input value={address} onChange={e => setAddress(e.target.value)} style={inputStyle} />
          
          <label style={labelStyle}>LOCATION</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <input value={exactLoc} onChange={e => setExactLoc(e.target.value)} placeholder="Exact location" style={inputStyle} />
            <button type="button" style={{ ...btnStyle, fontSize: "16px", padding: "0 12px" }}>⚲</button>
          </div>
          
          <label style={labelStyle}>DATE</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
          
          <label style={labelStyle}>TIME</label>
          <input type="time" value={time} onChange={e => setTime(e.target.value)} style={inputStyle} />
        </div>

        {/* Toggles Container */}
        <div style={{ backgroundColor: colors.surface, borderRadius: "8px", padding: "12px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Was the work performed by a Contractor?</span>
            <input type="checkbox" checked={isContractor} onChange={e => setIsContractor(e.target.checked)} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Was this observed during working hours?</span>
            <input type="checkbox" checked={isWorkHours} onChange={e => setIsWorkHours(e.target.checked)} />
          </div>

          <div style={{ display: "flex", gap: "4px" }}>
            {["Behaviour", "Condition"].map(t => (
              <button key={t} type="button" onClick={() => setObsType(t)} style={{ flex: 1, padding: "4px", backgroundColor: obsType === t ? colors.input_bg : "transparent", border: `1px solid ${colors.border}`, borderRadius: "4px", fontWeight: "bold", fontSize: "11px", cursor: "pointer" }}>{t}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Safe", "At Risk"].map(t => (
              <button key={t} type="button" onClick={() => setObsSafe(t)} style={{ flex: 1, padding: "4px", backgroundColor: obsSafe === t ? colors.input_bg : "transparent", border: `1px solid ${colors.border}`, borderRadius: "4px", fontWeight: "bold", fontSize: "11px", cursor: "pointer" }}>{t}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Hatch office", "Home office", "Site/Client"].map(t => (
              <button key={t} type="button" onClick={() => setOfficeLoc(t)} style={{ flex: 1, padding: "4px", backgroundColor: officeLoc === t ? colors.input_bg : "transparent", border: `1px solid ${colors.border}`, borderRadius: "4px", fontWeight: "bold", fontSize: "11px", cursor: "pointer" }}>{t}</button>
            ))}
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
          <input value={category} onChange={e => setCategory(e.target.value)} placeholder="Select category" style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>SAFETY CARD TYPE</label>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" onClick={() => setCardType("Design")} style={{ ...btnStyle, flex: 1, backgroundColor: cardType === "Design" ? "#F3C200" : colors.surface, color: cardType === "Design" ? "#1A1A1A" : colors.text_muted }}>Design</button>
            <button type="button" onClick={() => setCardType("Field")} style={{ ...btnStyle, flex: 1, backgroundColor: cardType === "Field" ? "#1A7F37" : colors.surface, color: cardType === "Field" ? "#FFFFFF" : colors.text_muted }}>Field</button>
            <button type="button" onClick={() => setCardType("Office")} style={{ ...btnStyle, flex: 1, backgroundColor: cardType === "Office" ? "#0D8BFF" : colors.surface, color: cardType === "Office" ? "#FFFFFF" : colors.text_muted }}>Office</button>
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
