// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::thread;
use std::time::Duration;
use headless_chrome::{Browser, LaunchOptions};
use keyring::Entry;

#[tauri::command]
fn submit_observation(payload: String) -> String {
    // Basic handler that returns a success string to the React frontend
    format!("Observation received successfully: {}", payload)
}

#[tauri::command]
async fn submit_to_copilot(prompt: String) -> Result<String, String> {
    // Create a mega prompt that instructs Copilot to return structured JSON
    let mega_prompt = format!(
        r#"You are a safety observation assistant. Based on the following observation description, extract and return ONLY a valid JSON object with these exact fields:

Observation: "{}"

Return ONLY this JSON structure (no markdown, no explanation, just the JSON):
{{
  "project": "string - infer project name or use 'Unknown'",
  "office": "string - infer office location or use 'Unknown'",
  "address": "string - infer address or use 'Unknown'",
  "exactLoc": "string - specific location from observation",
  "date": "string - today's date in YYYY-MM-DD format",
  "time": "string - current time in HH:MM format",
  "isContractor": boolean - true if observation involves contractor,
  "isWorkHours": boolean - true if during work hours,
  "obsType": "string - one of: Behaviour, Condition, Environmental",
  "obsSafe": "string - one of: Safe, At Risk",
  "officeLoc": "string - one of: Site/Client, Office, Other",
  "details": "string - detailed description of the observation",
  "action": "string - recommended action taken or to be taken",
  "category": "string - safety category (e.g., PPE, Housekeeping, etc.)",
  "cardType": "string - one of: Field, Office"
}}"#,
        prompt
    );

    automate_copilot_submission(&mega_prompt)
        .await
        .map_err(|e| format!("Failed to submit to Copilot: {}", e))
}

async fn automate_copilot_submission(prompt: &str) -> Result<String, Box<dyn std::error::Error>> {
    // Launch Chrome (visible so user can see the process)
    let browser = Browser::new(LaunchOptions {
        headless: false,
        ..Default::default()
    })?;
    
    let tab = browser.new_tab()?;
    
    // Navigate to Copilot
    tab.navigate_to("https://copilot.microsoft.com/")?;
    tab.wait_until_navigated()?;
    
    // Wait for chat interface to be ready (look for textarea)
    let mut retries = 0;
    while retries < 15 {
        let chat_ready = tab.evaluate(
            r#"document.querySelector('textarea') !== null"#,
            false
        )?;
        
        if let Some(val) = chat_ready.value {
            if val.as_bool().unwrap_or(false) {
                // Found the textarea, wait a bit more for it to be fully interactive
                thread::sleep(Duration::from_millis(500));
                break;
            }
        }
        
        thread::sleep(Duration::from_millis(500));
        retries += 1;
    }
    
    if retries >= 15 {
        return Err("Chat interface did not load in time".into());
    }
    
    // Find and fill the chat input with the mega prompt
    let escaped_prompt = prompt.replace("\\", "\\\\").replace("`", "\\`").replace("$", "\\$").replace("\n", "\\n");
    tab.evaluate(
        &format!(r#"
            const input = document.querySelector('textarea');
            if (input) {{
                input.value = `{}`;
                input.dispatchEvent(new Event('input', {{ bubbles: true }}));
                input.focus();
            }}
        "#, escaped_prompt),
        false
    )?;
    
    // Keep browser open indefinitely for manual interaction
    println!("Prompt pasted into Copilot. Browser will remain open for manual submission and debugging...");
    println!("Please manually submit the prompt and review the response.");
    
    // Keep browser open for a long time (5 minutes) for debugging
    thread::sleep(Duration::from_secs(300));
    
    // Return a placeholder response
    Ok(r#"{"message": "Manual submission required - please submit the prompt in the browser window"}"#.to_string())
}

fn extract_json_from_response(text: &str) -> Result<String, Box<dyn std::error::Error>> {
    // Try to find JSON object in the response
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            let json_str = &text[start..=end];
            // Validate it's valid JSON
            serde_json::from_str::<serde_json::Value>(json_str)?;
            return Ok(json_str.to_string());
        }
    }
    
    Err("No valid JSON found in response".into())
}

#[tauri::command]
fn store_credentials(email: String, password: String) -> Result<String, String> {
    let email_entry = Entry::new("roam-logger", "hatch-email")
        .map_err(|e| e.to_string())?;
    let password_entry = Entry::new("roam-logger", "hatch-password")
        .map_err(|e| e.to_string())?;
    
    email_entry.set_password(&email).map_err(|e| e.to_string())?;
    password_entry.set_password(&password).map_err(|e| e.to_string())?;
    
    Ok("Credentials stored securely".to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            submit_observation, 
            submit_to_copilot,
            store_credentials
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
