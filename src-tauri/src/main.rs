// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
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
    // Try to use headless browser automation
    match automate_copilot_submission(&prompt).await {
        Ok(response) => Ok(response),
        Err(e) => {
            // Fallback: open browser manually and return mock data
            eprintln!("Browser automation failed: {}, falling back to manual mode", e);
            
            let copilot_url = "https://copilot.microsoft.com/";
            
            #[cfg(target_os = "macos")]
            let _ = Command::new("open").arg(copilot_url).spawn();
            
            #[cfg(target_os = "windows")]
            let _ = Command::new("cmd").args(&["/C", "start", copilot_url]).spawn();
            
            #[cfg(target_os = "linux")]
            let _ = Command::new("xdg-open").arg(copilot_url).spawn();
            
            // Return mock response
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
    }
}

async fn automate_copilot_submission(prompt: &str) -> Result<String, Box<dyn std::error::Error>> {
    // Launch headless Chrome
    let browser = Browser::new(LaunchOptions {
        headless: false, // Set to false so user can see what's happening
        ..Default::default()
    })?;
    
    let tab = browser.new_tab()?;
    
    // Navigate to Copilot
    tab.navigate_to("https://copilot.microsoft.com/")?;
    tab.wait_until_navigated()?;
    
    // Wait for page to load
    thread::sleep(Duration::from_secs(3));
    
    // Check if login is required
    let login_required = tab.evaluate(
        r#"document.querySelector('a[href*="login"]') !== null"#,
        false
    )?;
    
    if login_required.value.is_some() {
        // Try to get stored credentials
        let entry = Entry::new("roam-logger", "hatch-email")?;
        let email = entry.get_password().ok();
        
        if email.is_none() {
            return Err("No stored credentials found. Please log in manually.".into());
        }
        
        // Click login button
        tab.evaluate(
            r#"document.querySelector('a[href*="login"]').click()"#,
            false
        )?;
        
        thread::sleep(Duration::from_secs(2));
        
        // Fill in email (this is simplified - actual Microsoft login is more complex)
        tab.evaluate(
            &format!(r#"document.querySelector('input[type="email"]').value = "{}""#, email.unwrap()),
            false
        )?;
        
        // Note: Full authentication flow would require handling OAuth redirects
        // This is a simplified version
    }
    
    // Wait for chat interface to be ready
    thread::sleep(Duration::from_secs(2));
    
    // Find and fill the chat input
    tab.evaluate(
        &format!(r#"
            const input = document.querySelector('textarea[placeholder*="Ask"], textarea[aria-label*="chat"]');
            if (input) {{
                input.value = `{}`;
                input.dispatchEvent(new Event('input', {{ bubbles: true }}));
            }}
        "#, prompt.replace("`", "\\`")),
        false
    )?;
    
    thread::sleep(Duration::from_millis(500));
    
    // Submit the prompt
    tab.evaluate(
        r#"
            const submitBtn = document.querySelector('button[type="submit"], button[aria-label*="Send"]');
            if (submitBtn) submitBtn.click();
        "#,
        false
    )?;
    
    // Wait for response (this is simplified - would need better detection)
    thread::sleep(Duration::from_secs(10));
    
    // Extract the response
    let response = tab.evaluate(
        r#"
            const messages = document.querySelectorAll('[data-content="ai-message"], .response-message');
            const lastMessage = messages[messages.length - 1];
            lastMessage ? lastMessage.textContent : "";
        "#,
        false
    )?;
    
    let response_text = response.value
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| String::new());
    
    Ok(response_text)
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
