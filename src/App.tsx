import { useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";

function App() {
  const [project, setProject] = useState("Hatch Global (Project View)");
  const [details, setDetails] = useState("");
  const [status, setStatus] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await invoke<string>("submit_observation", { 
        payload: JSON.stringify({ project, details }) 
      });
      setStatus(result);
    } catch (error) {
      setStatus(`Error: ${error}`);
    }
  };

  return (
    <div style={{ padding: "20px", fontFamily: "Source Sans Pro, sans-serif", backgroundColor: "#FAFAFA", color: "#2E2E2E", minHeight: "100vh" }}>
      <h2>Roam Observation Logger</h2>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "10px", maxWidth: "500px" }}>
        
        <label>PROJECT</label>
        <select value={project} onChange={(e) => setProject(e.target.value)} style={{ padding: "8px" }}>
          <option>Hatch Global (Project View)</option>
          <option>H-370104 RTA-AP60 Smelter Expansion</option>
        </select>

        <label>OBSERVATION DETAILS</label>
        <textarea 
          rows={4} 
          value={details} 
          onChange={(e) => setDetails(e.target.value)}
          placeholder="Enter observation details..."
          style={{ padding: "8px" }}
        />

        <button type="submit" style={{ padding: "10px", backgroundColor: "#425563", color: "white", border: "none", cursor: "pointer", marginTop: "10px" }}>
          Submit Observation
        </button>
      </form>
      {status && <p style={{ marginTop: "20px", fontWeight: "bold" }}>{status}</p>}
    </div>
  );
}

export default App;
