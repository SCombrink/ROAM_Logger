// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;

#[tauri::command]
fn submit_observation(payload: String) -> String {
    // Basic handler that returns a success string to the React frontend
    format!("Observation received successfully: {}", payload)
}

#[tauri::command]
async fn submit_to_copilot(prompt: String) -> Result<String, String> {
    // Open Copilot in the default browser
    let copilot_url = "https://copilot.microsoft.com/";
    
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(copilot_url).spawn();
    
    #[cfg(target_os = "windows")]
    let _ = Command::new("cmd").args(&["/C", "start", copilot_url]).spawn();
    
    #[cfg(target_os = "linux")]
    let _ = Command::new("xdg-open").arg(copilot_url).spawn();
    
    // Return a mock structured response that simulates AI parsing
    // In production, this would use browser automation to:
    // 1. Navigate to Copilot
    // 2. Handle authentication
    // 3. Submit the prompt
    // 4. Wait for and capture the response
    
    let mock_response = format!(r#"{{
        "project": "Hatch Global (Project View)",
        "office": "Johannesburg",
        "address": "58 Emerald Parkway Road, Greenstone Hill",
        "exactLoc": "Construction site area",
        "date": "2026-04-05",
        "time": "14:30",
        "isContractor": false,
        "isWorkHours": true,
        "obsType": "Behaviour",
        "obsSafe": "Safe",
        "officeLoc": "Site/Client",
        "details": "{}",
        "action": "Acknowledged safe practice and encouraged continuation",
        "category": "Personal Protective Equipment",
        "cardType": "Field"
    }}"#, prompt);
    
    Ok(mock_response)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![submit_observation, submit_to_copilot])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
