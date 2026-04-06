// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::thread;
use std::time::Duration;
use headless_chrome::{Browser, LaunchOptions};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

struct ApiKeyState(Mutex<Option<String>>);

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
    tab.navigate_to("https://m365.cloud.microsoft/chat")?;
    tab.wait_until_navigated()?;
    
    // Check if login is required
    let mut login_retries = 0;
    let mut login_detected = false;
    
    // Increase timeout to 5 minutes (300 retries * 1 second) to allow for multi-step login
    while login_retries < 300 {
        // Check for login page indicators
        let needs_login = tab.evaluate(
            r#"
                // Check for common login page elements
                const hasSignInButton = document.querySelector('input[type="submit"][value*="Sign in"]') !== null ||
                                       document.querySelector('button[type="submit"]') !== null && 
                                       document.querySelector('input[type="email"], input[type="text"][name*="user"], input[name*="login"]') !== null;
                const hasEmailInput = document.querySelector('input[type="email"], input[name*="email"], input[name*="user"]') !== null;
                const hasPasswordInput = document.querySelector('input[type="password"]') !== null;
                const hasLoginText = document.body.textContent.toLowerCase().includes('sign in') || 
                                    document.body.textContent.toLowerCase().includes('log in');
                
                hasSignInButton || (hasEmailInput && hasLoginText) || hasPasswordInput;
            "#,
            false
        )?;
        
        if let Some(val) = needs_login.value {
            if val.as_bool().unwrap_or(false) {
                if !login_detected {
                    println!("Login required. Please complete the login process in the browser window...");
                    login_detected = true;
                }
                thread::sleep(Duration::from_secs(2));
                login_retries += 1;
                continue;
            }
        }
        
        // Check if chat interface is ready (no login needed or login completed)
        let chat_ready = tab.evaluate(
            r#"document.querySelector('textarea') !== null"#,
            false
        )?;
        
        if let Some(val) = chat_ready.value {
            if val.as_bool().unwrap_or(false) {
                if login_detected {
                    println!("Login completed successfully! Chat interface is ready.");
                }
                // Found the textarea, wait longer for it to be fully interactive and page to settle
                thread::sleep(Duration::from_secs(2));
                break;
            }
        }
        
        thread::sleep(Duration::from_secs(1));
        login_retries += 1;
    }
    
    if login_retries >= 300 {
        return Err("Chat interface did not load in time (timeout after 5 minutes)".into());
    }
    
    // Check for and click the "Agree & Continue" button if present
    let button_clicked = tab.evaluate(
        r#"
            const button = Array.from(document.querySelectorAll('button')).find(btn => 
                btn.textContent.toLowerCase().includes('agree') || 
                btn.textContent.toLowerCase().includes('continue')
            );
            if (button) {
                button.click();
                true;
            } else {
                false;
            }
        "#,
        false
    )?;
    
    // If button was clicked, wait for the page to settle
    if let Some(val) = button_clicked.value {
        if val.as_bool().unwrap_or(false) {
            println!("Clicked 'Agree & Continue' button");
            thread::sleep(Duration::from_secs(2));
            
            // Wait for textarea to be ready again after clicking button
            let mut retries = 0;
            while retries < 10 {
                let chat_ready = tab.evaluate(
                    r#"document.querySelector('textarea') !== null"#,
                    false
                )?;
                
                if let Some(val) = chat_ready.value {
                    if val.as_bool().unwrap_or(false) {
                        thread::sleep(Duration::from_millis(500));
                        break;
                    }
                }
                
                thread::sleep(Duration::from_millis(500));
                retries += 1;
            }
        }
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
    
    thread::sleep(Duration::from_millis(600));
    
    // Press Enter to submit
    match tab.evaluate(
        r#"
            const input = document.querySelector('textarea');
            if (input) {
                const enterEvent = new KeyboardEvent('keydown', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true
                });
                input.dispatchEvent(enterEvent);
                true;
            } else {
                false;
            }
        "#,
        false
    ) {
        Ok(result) => {
            if let Some(val) = result.value {
                if !val.as_bool().unwrap_or(false) {
                    return Err("Failed to submit prompt - textarea not found".into());
                }
            }
        }
        Err(e) => {
            return Err(format!("Failed to submit prompt: {}", e).into());
        }
    }
    
    // Wait for response to appear and complete
    thread::sleep(Duration::from_secs(3));
    
    // Wait for the response to finish generating (look for stop button to disappear)
    let mut wait_count = 0;
    while wait_count < 30 {
        match tab.evaluate(
            r#"document.querySelector('button[aria-label*="Stop"]') !== null"#,
            false
        ) {
            Ok(is_generating) => {
                if let Some(val) = is_generating.value {
                    if !val.as_bool().unwrap_or(false) {
                        break;
                    }
                }
            }
            Err(e) => {
                println!("Warning: Error checking generation status: {}", e);
                // Continue anyway, might just be a timing issue
            }
        }
        
        thread::sleep(Duration::from_secs(1));
        wait_count += 1;
    }
    
    // Give it a moment to fully render
    thread::sleep(Duration::from_secs(2));
    
    // Extract the response text
    let response_text = match tab.evaluate(
        r#"
            const messages = document.querySelectorAll('[class*="message"], [class*="response"]');
            let lastAiMessage = null;
            for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                if (msg.textContent && msg.textContent.includes('{')) {
                    lastAiMessage = msg;
                    break;
                }
            }
            lastAiMessage ? lastAiMessage.textContent : "";
        "#,
        false
    ) {
        Ok(response) => {
            response.value
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| String::new())
        }
        Err(e) => {
            return Err(format!("Failed to extract response: {}", e).into());
        }
    };
    
    // Try to extract JSON from the response
    let json_response = extract_json_from_response(&response_text)?;
    
    // Keep browser open indefinitely - user must close it manually
    println!("Response received. Browser will remain open - please close it manually when done.");
    println!("Response: {}", json_response);
    
    // Sleep for a very long time (effectively indefinite)
    thread::sleep(Duration::from_secs(3600)); // 1 hour
    
    Ok(json_response)
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
async fn store_api_key(key: String, state: State<'_, ApiKeyState>) -> Result<String, String> {
    let trimmed_key = key.trim().to_string();
    
    // Validate the API key by making a minimal request
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let test_request = GroqRequest {
        model: "llama-3.3-70b-versatile".to_string(),
        messages: vec![Message {
            role: "user".to_string(),
            content: "Ping".to_string(),
        }],
        temperature: 0.0,
        max_tokens: 1,
    };

    let response = client
        .post("https://api.groq.com/openai/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", trimmed_key))
        .header("Content-Type", "application/json")
        .json(&test_request)
        .send()
        .await
        .map_err(|e| format!("Connection error: {}", e))?;

    if !response.status().is_success() {
        return Err("Invalid API Key: Authentication failed".to_string());
    }

    *state.0.lock().unwrap() = Some(trimmed_key);
    Ok("API key validated and stored".to_string())
}

// Structs for Groq API request/response
#[derive(Serialize)]
struct GroqRequest {
    model: String,
    messages: Vec<Message>,
    temperature: f32,
    max_tokens: u32,
}

#[derive(Serialize, Deserialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct GroqResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: Message,
}

use chrono::Local;

#[tauri::command]
async fn chat_with_ai(prompt: String, state: State<'_, ApiKeyState>) -> Result<String, String> {
    let today_str = Local::now().format("%d %B %y").to_string();
    let categories = "Access / Egress, Biological, Chemicals / Hazardous Substances, Driving / Transport, Electrical, Ergonomics, Falling Objects, Fire / Explosion, Hand Tools, Hot Work, Housekeeping, Lifting / Rigging, Manual Handling, Mechanical / Machinery, Noise, PPE, Slips / Trips / Falls, Working at Heights, Other";

    // Retrieve API key from cache or environment variable
    let api_key = {
        let api_key_lock = state.0.lock().unwrap();
        
        if let Some(key) = api_key_lock.as_ref() {
            key.clone()
        } else {
            std::env::var("GROQ_API_KEY")
                .map(|k| k.trim().to_string())
                .map_err(|_| "GROQ_API_KEY environment variable not set and no API key provided in settings".to_string())?
        }
    };
    
    // Build the request payload
    let request_body = GroqRequest {
        model: "llama-3.3-70b-versatile".to_string(),
        messages: vec![
            Message {
                role: "system".to_string(),
                content: format!(
                    r#"Analyze the following safety observation report and extract the details into a strict JSON format. 
If a field is not mentioned, use the defaults provided or leave as an empty string.

IMPORTANT NOTE ON DATES: Today's date is {today_str}. If the report mentions 'today', 'yesterday', or gives no date at all, resolve the date relative to {today_str}.

Instructions:
1. First, evaluate if the user's input contains a legitimate safety observation (something they saw, an action they took, or a condition).
2. If the input is just a greeting (like "hi", "hello") or unrelated chatter, respond naturally but DO NOT include the JSON or the completion message. Simply ask them to describe their observation.
3. If it is a valid observation:
    a. "project" defaults to "Hatch Global (Project View)". If the user mentions another project name or a 6-digit project number, use that instead.
    b. "details" must be a clear, professional, third-person structured sentence for learning.
    c. "action" must be in the FIRST PERSON (e.g., "I did...", "I saw...").
    d. "isContractor" MUST be "Yes" if the description mentions a contractor, vendor, or supplier. Otherwise "No".
    e. "isWorkHours" defaults to "Yes", but set to "No" if the activity is described as occurring on a weekend or explicitly outside of working hours.
    f. "officeLoc" defaults to "Hatch office". Set to "Home office" ONLY if the user mentions working from home. Use "Site/Client" for client offices, mines, or construction sites.
    g. Once you have enough information to reasonably infer the fields, return the JSON object followed by: "Thank you for the observation. The ROAM form has been populated for you. You can click Submit Observation when ready."

Return ONLY valid JSON matching this exact structure (no markdown tags) IF AND ONLY IF a valid observation is being processed:
{{
  "error": "string (If the input is gibberish, random background noise, or completely unrelated to a safety observation, explain why here and leave other fields empty. Otherwise leave empty.)",
  "project": "string (Default: 'Hatch Global (Project View)')",
  "exactLoc": "string (Extract the exact location where the incident happened, like 'hallway', 'near a desk', or specific room. Default to 'Office' or 'Home' ONLY if there is a slight mention of being at the office or working from home. Otherwise, identify the exact place.)",
  "date": "dd MMMM yyyy" (Default: "{today_str}"),
  "isContractor": "Yes" or "No",
  "isWorkHours": "Yes" or "No",
  "obsType": "Behaviour" or "Condition",
  "obsSafe": "Safe" or "At Risk",
  "officeLoc": "Hatch office", "Home office", or "Site/Client",
  "details": "string",
  "action": "string",
  "category": "string (MUST exactly match one of: {categories})",
  "cardType": "Design", "Field", or "Office"
}}"#),
            },
            Message {
                role: "user".to_string(),
                content: prompt,
            }
        ],
        temperature: 0.7,
        max_tokens: 1024,
    };
    
    // Create HTTP client with timeout
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    
    // Make the API request
    let response = client
        .post("https://api.groq.com/openai/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", e))?;
    
    // Check if request was successful
    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("API returned error {}: {}", status, error_text));
    }
    
    // Parse the JSON response
    let groq_response: GroqResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse API response: {}", e))?;
    
    // Extract the AI's message
    groq_response
        .choices
        .first()
        .map(|choice| choice.message.content.clone())
        .ok_or_else(|| "No response from AI".to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(ApiKeyState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            submit_observation, 
            submit_to_copilot,
            store_api_key,
            chat_with_ai
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
