// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::thread;
use std::time::Duration;
use headless_chrome::{Browser, LaunchOptions};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{State, Manager};

#[tauri::command]
async fn submit_observation(payload: String, headless: bool) -> Result<String, String> {
    let json_payload: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|e| format!("Failed to parse payload: {}", e))?;

    let edge_path = std::path::PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe");
    let browser_path = if edge_path.exists() { Some(edge_path) } else { None };

    let browser = Browser::new(LaunchOptions {
        headless,
        path: browser_path,
        enable_gpu: true,
        ..Default::default()
    }).map_err(|e| format!("Failed to launch browser: {}. If on Windows, ensure Edge is installed.", e))?;

    let tab = browser.new_tab().map_err(|e| format!("Failed to create tab: {}", e))?;
    tab.navigate_to("https://ipassm/NetForms/#/new/ROAM-Online")
        .map_err(|e| format!("Failed to navigate: {}", e))?;
    
    // Polling for the iframe as per simple_roam_populator logic
    let mut frame_found = false;
    for _ in 0..45 {
        let check_frame = tab.evaluate("document.querySelector('#e360Frame') !== null", false)
            .map_err(|e| e.to_string())?;
        if check_frame.value.and_then(|v| v.as_bool()).unwrap_or(false) {
            frame_found = true;
            break;
        }
        thread::sleep(Duration::from_secs(1));
    }

    if !frame_found {
        return Err("Timed out waiting for ROAM iframe".to_string());
    }

    thread::sleep(Duration::from_secs(2));

    let script = format!(
        r#"
        (async function() {{
            const data = {};
            const frame = document.querySelector('#e360Frame').contentWindow.document;
            
            function setField(index, value) {{
                const inputs = Array.from(frame.querySelectorAll('input[type="text"], textarea, select'));
                const el = inputs[index];
                if (el) {{
                    el.value = value;
                    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    el.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Tab' }}));
                }}
            }}

            function setRadio(name, value, last = false) {{
                const radios = Array.from(frame.querySelectorAll(`input[type="radio"]`)).filter(r => {{
                    const label = frame.querySelector(`label[for="${{r.id}}"]`);
                    return label && label.innerText.trim() === value;
                }});
                const target = last ? radios[radios.length - 1] : radios[0];
                if (target) {{
                    target.click();
                }}
            }}

            // Implementation matching simple_roam_populator.py indices
            setField(2, data.project);
            setField(11, data.date);
            setField(12, data.time);
            setRadio('Contractor', data.isContractor ? 'Yes' : 'No');
            setRadio('WorkingHours', data.isWorkHours ? 'Yes' : 'No', true);
            setField(10, data.exactLoc);
            setField(8, data.officeLoc);
            setField(9, data.address);
            setField(13, data.obsType);
            setField(14, data.obsSafe);
            setField(15, data.details);
            setField(16, data.action);
            setField(17, data.category);

            // VFL Color Logic (ArrowDown trick simulation)
            const vflInput = Array.from(frame.querySelectorAll('input'))[18];
            if (vflInput) {{
                vflInput.value = "VFL";
                vflInput.dispatchEvent(new Event('input', {{ bubbles: true }}));
                const presses = data.cardType === 'Design' ? 1 : (data.cardType === 'Office' ? 3 : 2);
                for(let i=0; i<presses; i++) {{
                    vflInput.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'ArrowDown' }}));
                }}
                vflInput.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Tab' }}));
            }}

            // Submit
            const buttons = Array.from(frame.querySelectorAll('button'));
            if (buttons[1]) buttons[1].click();

            return "Success";
        }})();
        "#,
        json_payload
    );

    tab.evaluate(&script, false)
        .map_err(|e| format!("Automation error: {}", e))?;

    thread::sleep(Duration::from_secs(5));
    Ok("Observation submitted successfully".to_string())
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
  "time": "string - current time in HH:MM format (If unspecified, pick a random time on a 30-min increment: 09:00 to 17:00 if isWorkHours is true, otherwise pick a random time on a 30-min increment outside those hours)",
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
async fn get_cached_key(state: State<'_, ApiKeyState>) -> Result<Option<String>, String> {
    Ok(state.0.lock().unwrap().clone())
}

#[tauri::command]
async fn store_api_key(key: String, state: State<'_, ApiKeyState>, app_handle: tauri::AppHandle) -> Result<String, String> {
    let trimmed_key = key.trim().to_string();
    
    // Validate the API key by making a minimal request
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let test_request = GeminiRequest {
        contents: vec![GeminiContent {
            parts: vec![GeminiPart { text: "Ping".to_string() }]
        }],
        generationConfig: Some(GenerationConfig {
            maxOutputTokens: Some(1),
            temperature: Some(0.0),
        }),
    };

    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key={}", trimmed_key);
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&test_request)
        .send()
        .await
        .map_err(|e| format!("Connection error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        return match status.as_u16() {
            401 | 403 => Err("Invalid API Key: Authentication failed".to_string()),
            429 => Err("Rate limited: Too many requests. Please wait and try again.".to_string()),
            503 => Err("API error: Model is too busy or overloaded. Please try again later.".to_string()),
            _ => Err(format!("API validation failed with status: {}", status)),
        };
    }

    *state.0.lock().unwrap() = Some(trimmed_key.clone());
    
    if let Some(mut path) = app_handle.path_resolver().app_data_dir() {
        let _ = std::fs::create_dir_all(&path);
        path.push("key.cache");
        let _ = std::fs::write(path, trimmed_key);
    }

    Ok("API key validated and stored".to_string())
}

// Structs for Gemini API request/response
#[derive(Serialize)]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
    #[serde(rename = "generationConfig")]
    generationConfig: Option<GenerationConfig>,
}

#[derive(Serialize, Deserialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Serialize, Deserialize)]
struct GeminiPart {
    text: String,
}

#[derive(Serialize)]
struct GenerationConfig {
    #[serde(rename = "maxOutputTokens")]
    maxOutputTokens: Option<u32>,
    temperature: Option<f32>,
}

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Vec<GeminiCandidate>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: GeminiContent,
}

#[tauri::command]
async fn chat_with_ai(prompt: String, state: State<'_, ApiKeyState>) -> Result<String, String> {
    use chrono::Local;
    let today_str = Local::now().format("%d %B %y").to_string();
    let categories = "Access Breach, Barricading, Behaviour / General Conduct, Caught Between, Chemical, Collision, Confined Space, Contact With, Cyber security, Electrical, Equipment Failure, Ergonomics / Manual Handling, Excavation, Explosion, Fall from Above, Fall from Above Objects, Fall from Above Slips/Trips/Falls, Fire, Fire Prevention / Protection, Foreign Body, Hazardous Substances, Health/Medical/Disease, Housekeeping, Lifting and Rigging, Lockout/Tagout, Danger Tag/Isolation, Manual Handling, Mobile Equipment, Motor Vehicle, Noise, Over/Near Water, Permit to Work, Personal Protective Equipment, Procedure Breach, Quality Assurance/Quality Control, Security, Sharp Objects, Signage, Stacking Storage, Sustainability, Thermal Stress (Hot / Cold), Travel, Unguarded Equipment, Weather Conditions, Wildlife, Work at Heights, Workstation Ergonomics";

    let raw_projects = vec![
        "H-370104 RTA-AP60 Smelter Expansion", "H-366122 Integrated Lithium Project", "H-369146 JS2 Execution Engineering Services", 
        "H-376032 Windfall FS Study Management Consultant", "H-373719 Cameco EMBARK Project", "H-376337 Stibnite Gold Project", 
        "H-375044 New Micromill PCM Execution Phase", "H-375541 KL Program", "H-366551 Nolans Rare Earths Project", 
        "H-375270 BHP OD SCM27", "H-024810 Atlantic Copper - Circular", "H-375231 OD-SRE", "H-302412 TECHNOLOGIES - ADMIN", 
        "H-372486 Hermosa - Taylor Process Plant E&P", "H-375154 Lumwana Expansion Project", "H-375000 Jansen Stage 1 - EPCM HB JV", 
        "H-368092 USA RE Magnet Facility FEL2/3", "H-302083 INTERNAL FINANCE", "H-373068 PTFMR Commissioning Management - Exec", 
        "H-376461 Gary 84\" HSM API Implementation", "H-376621 Impala F4 Reline Engineering", "H-300629 Health & Safety Indirect", 
        "H-302040 INTERNAL IT Project", "H-375296 RTA - Laterriere Tailing Project", "H-375946 NeoSmelt ESF Pilot Feasibility", 
        "H-373373 Phase 2 - Fermeture Progressive d'Arvida", "H-302084 INTERNAL HUMAN RESOURCES", "H-366614 Rook I Project - FEED", 
        "H-377059 Willow Rock Energy Storage Center", "H-369140 Furnace Operations Support - MSA", "H-370751 EES - Platform Development", 
        "H-376521 Mt Holly PL2E FEL 4 - Execution", "H-372941 IOC - Dumper No.3", "H-302082 INTERNAL SHARED SERVICES", 
        "H-353100 Onaping Depth FEL4", "H-372899 Mactaquac Owner's Engineer", "H-376878 Sonatrach - FEED for Greenfield Complex", 
        "H-377266 New Continuous Caster for EC Rod Product", "H-373909 Vopak Victoria Energy Terminal Project", 
        "H-376794 FEL1 of Project Crucible", "H-300651 Pyrometallurgy Practice Indirect", "H-374109 Whabouchi Mine - Execution services", 
        "H-300330 EP&P - Indirect", "H-376717 Marinus Link - BoW Delivery Phase Design", "H-364159 Sishen Koketso Project", 
        "H-375370 PTFI Grasberg Mining Complex Simulation", "H-377071 Lone Tree Autoclave Restart - Execution", 
        "H-300536 Mechanical Indirect", "H-371959 GCO Phase 2 Expansion - Execution", 
        "H-024852 TBRC Band-und Bunkeranlage f?r das CRH-P", "H-300331 Vehicles & Operations Indirect", 
        "H-376592 Port Pirie Critical Minerals rebuild PFS", "H-300537 Structural Indirect", "H-302106 ET SYS DEV", 
        "H-376475 Aclara Carina REE Feasibility Study", "H-373313 Cadia Proj Integration & Tailings Infra", 
        "H-300655 Mining Practice Indirect", "H-376311 USS Mon Valley Hot Strip Mill FEL2", 
        "H-373216 Zimplats Technical Site Support (Stage 2", "H-300533 Electrical Indirect", 
        "H-375620 MX-East Harbour Transit Hub Alliance PAA", "H-353960 Annacis WWTP Outfall - CM", 
        "H-300724 Project Commercial Management Indirect", "H-300103 Consulting BD & Indirect", "H-359516 Lakeshore WPCP Expansion", 
        "H-369479 KSR", "H-376465 SSA New Manzanillo FEL 3 - Phase 1", "H-300535 Control and Automation Eng. Indirect", 
        "H-300621 Project Controls Indirect", "H-305412 TECHNOLOGY BUSINESS DEVELOPMENT", "H-372943 EHMP Phase 5 Au-C POX Plant FEL4", 
        "H-355608 REM - CIMA+/HATCH Coenterprise-Phase II", "H-300322 Transit Indirect", "H-369538 SCA Discharge Project - Detailed Design", 
        "H-376323 Neosmelt PMC", "H-300601 Advisory Indirect", "H-300654 Hydrometallurgy Practice Indirect", 
        "H-363270 Réfection majeure tunnel L-H-La Fontaine", "H-370446 Onca Puma Furnace 2 FEL 4", 
        "H-374343 PRC - Potasio Rio Colorado ? Basic Eng.", "H-300660 Commercial Practice Indirect", "H-376325 NeoSmelt Balance of Plant", 
        "H-376512 Zuuvch-Ovoo Uranium Project", "H-377352 TCM Restart S2/S3 Commissioning Services", "H-376658 Chavimochic - Phases 3-5", 
        "H-376914 Viridis Colossus Project DFS", "H-300303 E&S Indirect", "H-300411 Oil & Gas Indirect-old", "H-300631 Quality Indirect", 
        "H-365849 MMR Detailed Engineering", "H-300680 Climate Change Indirect", "H-370175 Project Trilogy FEL 2", 
        "H-376811 GBC Business Recovery Support", "H-300037 INDIRECT CIVIL / STRUCT / ARCH", "H-367584 CSC Infrastructure Design", 
        "H-370132 MX - EHTH Alliance Development Phase", "H-373109 General Electric - CER1 LCC EP1", 
        "H-377291 New Vertimill Detailed engineering", "H-368368 MSA 3037681 - HUB Caribe Reficar Coke Ex", 
        "H-374352 EES Demonstration Plant", "H-376958 Ingenier?a FEL3 Lixiviaci?n Clorurada RT", 
        "H-300657 Project Development Practice Indirect", "H-300659 Tailings Practice Indirect", 
        "H-301654 Education/Learning-Hydrometallurgy", "H-359514 Confederation Line Extension (OttawaLRT)", 
        "H-374069 ID, Adq. e Ing Resid Proy LSTS WP05/SP02", "H-375926 DNNP Subsequent Units Enhanced Modulariz", 
        "H-301133 PDG - Construction Mgmt", "H-376501 IORC Freeport McMoRan Integrated Remote", "H-377250 Bagdad PLS", 
        "H-300632 Risk Indirect", "H-303100 PDG DPD Program", "H-361242 CCSJV Env. Monitoring Services (Moz)", 
        "H-366181 Winnipeg NEWPCC Execution", "H-371909 Flotation Integrity Project", 
        "H-376681 ERA - Engineering Services for Decommiss", "H-300327 Tunneling Indirect", "H-300624 Procurement Indirect", 
        "H-305319 Business Development - Water", "H-370145 Programme ?lectrique sous-station et SF", "H-372842 Ageli PFS", 
        "H-374590 McCormick ?tude Projet Modernisation ?va", "H-376439 VZI - Gamsberg Phase 2 OR Programme", 
        "H-300622 Project Management Indirect", "H-354899 Annacis Water Supply Tunnel Eng Svcs", 
        "H-373121 Vianode - New Synthetic Graphite Large S", "H-376018 NWMO IPD - Category 6 (Nuclear Systems)", 
        "H-376831 ONTC WOP 1034 - TC Fuel Tank Regulation", "H-305420 Water Power Business Development", 
        "H-370675 Vale Overflow Engineering - EPCM", "H-374250 Worsley BOD Project FS", "H-374437 Sparrows Point Container Terminal", 
        "H-374662 GCO Phase 2 Expansion - Execution: Const", "H-376774 Cariboo Gold - EP", "H-377146 Magnet Plant P2/3/4 PFS", 
        "H- FMR Freeport Maynar Consolidated", "H-300431 eGrid Indirect", "H-300545 Engineering Management Indirect", 
        "H-370703 ALC - ASU in Becancour", "H-372223 5543 CTDOT New Coaches Base Order", "H-374525 IB Continuidad Nivel 1 - PMCHS", 
        "H-376262 MSO Churchill Falls Powerhouse ? Enginee", "H-300150 CORE Indirect", "H-300623 Construction Indirect", 
        "H-305432 Nuclear BD", "H-375456 ABI00008_P_BF_ABF#2 Refractory Relining", "H-376057 White Springs - Transformation", 
        "H-376636 Qatalum Larger Anode Project FEL-4", "H-377169 Chase Field 2025/2026 Rope Replacement", 
        "H-377275 Alcoa - ADQ Fluewall Replacement and Rai", "H-264910 SCRRA Eng and Tech Suppor", "H-300543 Information Management", 
        "H-305417 Base Metals Business Development", "H-366690 Miami Smelter Optimization Project (MSO)", 
        "H-367118 FoM ACP Debottlenecking", "H-370913 Pont de l'Ile aux Tourtes - Design", 
        "H-373003 BHP MSA Portfolio 2023-27 JS Secondments", "H-373058 Aurubis Hamburg - TK2Neo Design-Supply", "H-374376 Heat Pipes", 
        "H-375187 Dust-HVAC Assessment and Feasibility Eng", "H-375982 CN Zanardi Construction Skeena M87.2", "H-376269 CCUS Hub Study", 
        "H-376808 Bayside Phase 2 Expansion", "H-376858 Cat Arm Unit 3 Feasibility Study", 
        "H-377143 TSF2 Embankment Raise to RL 69m - Site", "H-377270 BF1 & BF2 Campaign Life Assessment Upd.", 
        "H-377381 RE Refinery DFS Ramp-up", "H-377393 Nyrstar Side Leach PFS", "H-300022 INDIRECT P&CM - PROJECT MANAGEMENT", 
        "H-300062 PDG Business Development", "H-300652 Ind. Clean Tech Practice Indirect", 
        "H-305601 Advisory - Investment & Bus Planning BD", "H-361955 Pattullo", "H-369998 South Airport Cargo Development", 
        "H-372339 6333 SEPTA M-4 Support", "H-374635 NEWPCC- Biosolids Facilities - EPD", "H-374860 EMME - Battery Sulphates Plant FEL3", 
        "H-375063 TCM EPCM (EP Phase)", "H-375141 APS Zimplats Spare Parts", "H-375897 Usure excessive du convoyeur d'alumine n", 
        "H-375998 Greenbushes Operations - Asset Managemen", "H-377216 Northern Water Supply Project Tender Des", 
        "H-377243 FEL2B - BFP Project", "H- Alcoa NE Alliance", "H-115739 Engcobo Ext", "H-300432 Nuclear Indirect", 
        "H-302103 CLient Action Team", "H-305219 Minerals Business Development", "H-305418 Bulk Metals Business Development", 
        "H-346175 N7 Upgrading at Vissershok", "H-366083 Gove Pond 5 Construction Support", 
        "H-367589 Tarquti Nunavik Renewable Power Projects", "H-375354 Santa Rita UG Mine FEL 3", 
        "H-376009 Construction d'un b?timent de service de", "H-376241 TPT ECM - Port of Saldanha", 
        "H-376925 VB Productive Capacity Increase PFS", "H-377296 Alcoa - (ABI00346) ABF #1 Reline", "H-264190 CT DOT- Eng. & Inspection", 
        "H-300320 Rail Indirect", "H-300326 Rail Systems Indirect", "H-300656 Mineral Processing Practice Indirect", 
        "H-305214 Light Metals Business Development", "H-347691 R22 Elimination of At-grade Railway Cros", 
        "H-355802 Melbourne Metro Independent Reviewer", "H-364822 Zimplats Smelter and SO2 Abatement", 
        "H-365911 X-Energy NRE Preliminary Design Support", "H-366295 TMRSM028 Bridge Assessment - Secondment", 
        "H-372652 2024 Teck Metals MSA Projects", "H-374463 Neptune B2D2 Project", "H-374688 Secondary Crusher Expansion", 
        "H-375907 Cadia Tailings STSFX BR Strategy and Est", "H-376216 Eolian Energy Smelter Concept Study", 
        "H-376597 PFS - Brook Mine Rare Earth Project", "H-376663 Slurry Dust Return System - Phase 1", 
        "H-377248 2026 Teck Metals MSA Projects", "H-377444 Fermeture du circuit de broyage U/G", "H-265005 NYCT R211 Car Procurement", 
        "H-300323 Aviation Indirect", "H-300343 Geotechnical Indirect", "H-300420 Energy", "H-301131 PDG - Project Controls", 
        "H-302087 INTERNAL EXECUTIVE", "H-305325 Business Development - Defence", "H-366162 Zero Carbon Lithium Definitive FS", 
        "H-370295 HONI Joint Use Review Program", "H-372840 SF4 Furnace Rebuild Engineering", 
        "H-373740 Ingenier?a Estudio Fase Selecci?n (SPS)", "H-374621 OR & Commissioning Plan Marcobre Undergr", 
        "H-376445 New Iron Ore & Pelletizing Facility PFS", "H-377106 3-D Model for Guthega Hydropower Station", 
        "H-377402 Copper DD Argentina", "H-377431 Hamilton LRT - Civil & Utilities", "H-377607 Donlin Gold POX/O2 FEED", 
        "H- 357829P - Portage Pea Project", "H-300539 Piping Indirect", "H-300630 Document Control Indirect", 
        "H-301533 Electrical Education & Training", "H-369592 IC Desarrollo Post. Akacias Guamal", 
        "H-371132 Kings Mountain Bridging to FEL 3", "H-373322 Thickener Optimization", "H-373436 Zimplats Technical Site Support (Site)", 
        "H-374136 PWSA - Lime Slurry", "H-375572 K+S Potash Canada 2025 Projects", 
        "H-376167 DNNP - DPSC Secondment of Drafting Suppo", "H-376673 CW EMD - Echo Point Facility FEL2", "H-376697 OPSP - FEL 2+", 
        "H-377053 JPMe Conceptual Studies", "H-377130 Alfalfal II and Las Lajas T&C Support", 
        "H-377260 TMC - US Onshore Smelter PFS Refresh", "H-377306 UO2 Process Study for Ammonium Hydroxide", 
        "H-377366 Raglan Wind Power Scoping 3.0", "H-377454 FEL3 - Jameson Cell Installation", "H-300023 INDIRECT P&CM - CONSTRUCTION", 
        "H-300328 Management & Delivery Indirect", "H-300546 Architecture Indirect", "H-360498 Contrato Marco Ing. Mayores DRT", 
        "H-366172 Nataka Pre-Fesibility Study", "H-373255 Nu-West CPO Compliance Projects", "H-374430 Alcoa Wagerup RSA10 - FEL3", 
        "H-374978 Water Pipeline to Milagro Plant", "H-375156 Boston Metal 300kA Basic", "H-376536 Jwaneng Underground - PFSB Study - ENG", 
        "H-377080 Nutrien - Aurora - Phos Acid - Phase 1", "H-377095 Smoky Creek & Guthrie's Gap - ECI Design", 
        "H-377189 PFS C?t? Gold Mill Expansion", "H-377232 Green Line LRT Downtown Functional Plan", 
        "H-377233 Jimblebar Dual TLO Upgrade EXE Phase", "H-377452 #2FF Cooler/Refractory QA & Inspections", 
        "H-377479 PLANIF. Y COMISIONADO IN-PIT TSF", "H- Global Construction Projects", "H-300548 Geotechnical Indirect", 
        "H-337520 Expansion of Hwange Power Plant", "H-357652 Technology Spare Parts Inventory", "H-363486 TransLink 193029-03 SkyTrain OMC4", 
        "H-368525 Mise ? jour devis normalis? tuyauterie", "H-369264 Begbie's Preferred Vendor Agreement-ZAR", 
        "H-372049 AAI - C00865 Rehausse des fours 3 et 4 -", "H-372058 6087 SEPTA - New Streetcar Engineering S", 
        "H-373113 OPG Kakabeka Life Extension", "H-373336 Transition ?nerg?tique IDLM", "H-374538 Manhattan Cruise Terminal Master Plan", 
        "H-374827 Hunter Power Plant - Commissioning Suppo", "H-375261 LTFT - HTFT Phase 2", 
        "H-376328 Bruce Hwy Walker St Intersection Upgrade", "H-376520 Peer Review OR - Proj Itabiritos", 
        "H-376637 PTP - Impala Furnace Operations Support", "H-376848 Beta - Dugong Co-Development Update", 
        "H-377050 Aclara REE Separation Plant US Basic Eng", "H-377267 EAF Slag Water Granulation Concept Engin", 
        "H-377379 Wet Way Process Engineering Study", "H-377437 Nova Sustainable Fuels Marine Terminal", 
        "H-377504 Drill and blast ROM Fragmentation Opt", "H-024808 EMSR KVA Delfzijl (DEL4)", "H-372709 KL Fixed Facil's BEng", 
        "H-373931 CORE Support for Iluka Balranald Project", "H-374058 Construction Mangt. Jamalco STG4", 
        "H-375235 Gestion ?quipe Construction Hatch 2025", "H-375759 SL3 Replacement Project - DPS and EXE", 
        "H-376176 P060178 Upgrade Engineering Services", "H-376371 Chemchemal Extended Well Test Detailed E", 
        "H-376672 BASF REE Magnet Recycling Options Study", "H-377079 BIM - 22Mpta via South Steensby Project", 
        "H-377279 Investigation of Road Access and Modular", "H-377280 Lone Tree Restart - CDE Program", "H-377562 Kemess Infrastructure PFS", 
        "H-263433 PATH- Railcar & Signal", "H-353906 Regional Express Rail (RER) Package 1", 
        "H-368519 PTA of WA C Series EMU Rolling Stock Qua", "H-370312 Williams Parkway Watermain", 
        "H-372207 EGP - Construction Management - Tunnel", "H-372727 Programme fuites d'eau", "H-373785 RTFT - RF", 
        "H-373982 TSF2 R5 Site Invest. Causeway DD & Lab", "H-374284 Snowy Hydro Hunter Protection Engineer", 
        "H-375307 Net zero roadmap - Codelco", "H-375503 Nutrien Projects Portfolio 2025-Ops", "H-375869 PWSA - 2023 SDWMR", 
        "H-376402 Freeport MicroGrid Controls + BESS", "H-376479 Process Engineering ? Transition Project", 
        "H-376699 CISDI UK - Tata Steel UK Coilbox Replace", "H-376898 Condensate Crossover Line ISP & KM250", 
        "H-376945 Regional Rail Project Fleet TA", "H-376972 Proy. Desarrollo Car?n", "H-377041 Zimplats F2 Performance Support FY25-26", 
        "H-377070 Stack Study for Radon Dispersion from Mi", "H-377325 Commissioning Planning and workforce eng", 
        "H-377330 Geotechnical Investigation of Vale BT16", "H-377354 Am?lioration de la section planage", 
        "H-377405 Tanduringie Creek Bridge Upgrade", "H-377500 Evaluacion Tecnica plan de desmantelamie", 
        "H-377603 Chevron Lithium Project - Pilot Plant Sc", "H-300342 Hydrotechnical Indirect", "H-300661 Simulation Practice Indirect", 
        "H-316117 Planning & Project Controller", "H-362025 Jadar FS", "H-362658 H362658 - Programme de Fours", 
        "H-366308 Big Eddy and Agnew Lake EOR", "H-366615 Green Line LRT Project", "H-370017 Estudio para la optimizacion del proceso", 
        "H-372592 Digues Beauharnois-Travaux prioritaires", "H-373289 Lester Kropp Bridge", "H-373908 CS Energy - Secondments", 
        "H-374512 HMGP Fire Protection 2025", "H-374571 Owner's Engineer for Trailroad Battery E", "H-374704 Spruce River Dam Safety Upgrades", 
        "H-375138 R262/R268 New Railcar Procurement - LNTP", "H-375143 BCH WRCS MSA - LDR - Implementation", 
        "H-375961 JR Simplot - Pipeline Capacity Expansion", "H-376141 Expansi?n Botadero de Ripios Fase X DGM", 
        "H-376223 ALCOSAN Retained Engineer - Misc Small P", "H-376273 Oakmont WWTP Upgrades - Construct. Phase", 
        "H-376751 Sino Iron TSF3 Tender Design", "H-376762 ENGINEERING AND CONSULTANT SERVICES FOR", 
        "H-376806 Steelscape Kalama-Blower Control Upgrade", "H-376866 Newfoundland and Labrador Hydro Battery", 
        "H-376891 Wet Process FEL2 Study", "H-377032 Pier 400 Electrification Feasibility", 
        "H-377090 Oklo - Aurora Used Core Assembly Storage", "H-377119 Manitoba Hydro 600 MW CT FEED Study", 
        "H-377132 Mosaic - Ona-Prewash & Screening Station", "H-377151 Strange Lake Refinery Residue PFS Update", 
        "H-377286 Battery Recycle DD", "H-377313 ATA Creep", "H-377318 ID Tratamiento Residuos Filtrados", 
        "H-377338 Catastrophic Risk Assurance Program 2026", "H-377350 Mt Milligan Feasibility Study Eng'g", 
        "H-377424 QMM WCP Upgrades - FEED Engineering", "H-377458 Evaluation of bauxite and alumina supply", 
        "H-377481 Maaden Elevate - PMO - Early Works Packa", "H-377515 Mine-to-Process Optimisation Greenbushes", 
        "H-377593 PH Tailings Capacity Replacement IPS", "H- 348883 EXCLUDE CONTRACTOR HOURS Constellium EPCM Alliance", 
        "H- TiO4 Program - Canada", "H-264550 LIRR/MNR PostAwrd Sup", "H-295030 Technologies", "H-295555 CRISP+", 
        "H-300124 INDIRECT PROCUREMENT-ENERGY", "H-300242 Risk - Indirect Project", "H-300319 Water Indirect", 
        "H-300321 Ports & Terminals Indirect", "H-301100 PDG - Global Safety", "H-301536 Mechanical Education & Training", 
        "H-301651 Education/Learning-Pyrometallurgy", "H-326000 AP60 - Phase 1", "H-351362 Burnhamthorpe Road Watermain", 
        "H-365948 COMILOG IROC Building", "H-367314 IBP - Independent Technical Advisor", "H-367431 Kemerton Expansion Project", 
        "H-368002 Gove Refinery Closure - Detailed Design", "H-368673 R?fection des caissons 501 ? 508 du CDS", 
        "H-370318 Off-Gas Managem - Glencore Horne Smelter", "H-370571 JD Irving-Brighton Mountain Wind Farm", 
        "H-372938 Jimblebar - Dual Bin TLO Replacement - D", "H-373208 Remplacement des groupes 6 et 7", 
        "H-373303 MLAP - Hatch JV Admin Effort", "H-373610 6158 LA Metro - HR5000 Heavy Rail Projec", 
        "H-373713 Brisbane Cross River Rail - CPS", "H-373824 Ertis HMP - Custom Equipment Supply", 
        "H-373862 USS Great Lakes Work Pickle Line Upgrade", "H-374403 BRDA 5 Decant Pond Infrastructure PFS", 
        "H-374419 REE Recovery from Coal Based Sources FS", "H-374472 Spodumene to LHM PFS", "H-374655 GISTM for Nexa", 
        "H-375291 Mosaic - Riverview - Evaporator #7 & #8", "H-375455 Cameco Assigned Resources - Miscellaneou", 
        "H-375591 ABI00217_OPP. INC. EE by Incr. AnodeSize", "H-375626 Simplot RS Granulation FEL2/FEL3 Upgrade", 
        "H-375696 DLE Greenfield Scoping Study", "H-375699 ANSTO Radiological Waste Disposal Pathwa", 
        "H-375750 18313-0C No 2 FF Major Rebuild PMP FEL3", "H-375842 HHT 2025 Capital Works Projects", 
        "H-376062 Sea Island Renewable Energy", "H-376090 CLP 1.5", "H-376101 FEED for Mahalo Water Management", 
        "H-376331 PWSA - 2025 Urgent Water- IEI", "H-376500 Port Hope Emergency Ventilation Study", 
        "H-376530 Traction Substation Feasibility Study -", "H-376711 Phoenix Tailings RE Refinery Engineering", 
        "H-376741 Development of Asset Integrity Documents", "H-376796 Turbine Foundation Design", 
        "H-376903 Northam F1 Upgrade Basic Engineering", "H-376920 Antamina F9C Soporte Ing. Detalle", 
        "H-376953 Waterloo Hydro. - Greaseless Conversion", "H-376966 Air Pollution Control Analysis and Re-De", 
        "H-376985 Iluka Eneabba RE Refinery Commissioning", "H-377088 Projeto PET - Opera??o Norte", 
        "H-377109 BMA Peak Downs - Tailings Pipeline Asses", "H-377125 CBC Scale-Up", "H-377212 H2OK Asset Preservation", 
        "H-377225 USSteel Gary -BFG and NG Optimization", "H-377398 High-level Review of IAA Operations", 
        "H-377412 IB Dirty Air Duct - Detailed Design Post", "H-377503 DRI Transport Assessment ? Phase 2", 
        "H-377534 Nyrstar Hobart Clean Jarosite - PFS", "H-377545 Project Isthmus - Panama DD"
    ];

    // Retrieve API key from cache or environment variable
    let api_key = {
        let api_key_lock = state.0.lock().unwrap();
        
        if let Some(key) = api_key_lock.as_ref() {
            key.clone()
        } else {
            std::env::var("GEMINI_API_KEY")
                .map(|k| k.trim().to_string())
                .map_err(|_| "GEMINI_API_KEY environment variable not set and no API key provided in settings".to_string())?
        }
    };
    
    let system_instructions = format!(
                    r#"Analyze the following safety observation report and extract the details into a strict JSON format. 
If a field is not mentioned, use the defaults provided or leave as an empty string.

IMPORTANT NOTE ON DATES: Today's date is {today_str}. If the report mentions 'today', 'yesterday', or gives no date at all, resolve the date relative to {today_str}.

Instructions:
1. First, evaluate if the user's input contains a greeting (like "hi", "hello") or unrelated chatter. If it does, respond naturally but DO NOT include the JSON or the completion message. Simply ask them to describe their observation.
2. Accept ALL safety observations regardless of location. Observations can happen anywhere (work, home, public, commute). 
3. If it is a valid observation:
    a. "project" MUST be the exact full string from the provided project list. Cross-reference the user's input (project number or name) against this list and choose the most appropriate one: {raw_projects:?}. If no match is found, default to "Hatch Global (Project View)".
    b. "details" must be a clear, professional, third-person structured sentence for learning.
    c. "action" must be in the FIRST PERSON (e.g., "I did...", "I saw...").
    d. "isContractor" MUST be "Yes" if the description mentions a contractor, vendor, or supplier. Otherwise "No".
    e. "isWorkHours" defaults to "Yes", but set to "No" if the activity is described as occurring on a weekend or explicitly outside of working hours.
    f. "officeLoc" defaults to "Hatch office". Set to "Home office" ONLY if the user mentions working from home. Use "Site/Client" for client offices, mines, or construction sites.
    g. If the "action" is not clear from the provided details, suggest a good immediate action that would have made the situation safe or better.
    h. "category" MUST exactly match one of the following: {categories}.
    i. Once you have enough information to reasonably infer the fields, return the JSON object followed by: "Thank you for the observation. The ROAM form has been populated for you. You can click Submit Observation when ready."

Return ONLY valid JSON matching this exact structure (no markdown tags) IF AND ONLY IF a valid observation is being processed:
{{
  "error": "string (If the input is gibberish or random background noise, explain why here. Do NOT use this for observations that happened outside of work. Otherwise leave empty.)",
  "project": "string (MUST be the full exact string from the project list if the user's number or name matches. Default: 'Hatch Global (Project View)')",
  "exactLoc": "string (Extract the exact location where the incident happened, like 'hallway', 'kitchen', 'parking lot', 'commute', etc. Identify the exact place described by the user.)",
  "date": "dd/MMM/yyyy" (Example: 04/Mar/2026. Default: "{today_str}"),
  "time": "HH:MM" (If unspecified by the user, generate a random time on a 30-minute increment: between 09:00 and 17:00 if isWorkHours is 'Yes', otherwise pick a random 30-min increment time outside of 09:00-17:00. Default to current time in 24h format if randomization fails),
  "isContractor": "Yes" or "No",
  "isWorkHours": "Yes" or "No",
  "obsType": "Behaviour" or "Condition",
  "obsSafe": "Safe" or "At Risk",
  "officeLoc": "Hatch office", "Home office", or "Site/Client",
  "details": "string",
  "action": "string",
  "category": "string (MUST exactly match one of: {categories})",
  "cardType": "Design", "Field", or "Office"
}}"#);

    // Build the request payload
    let request_body = GeminiRequest {
        contents: vec![GeminiContent {
            parts: vec![GeminiPart { text: format!("{}\n\nUser Input: {}", system_instructions, prompt) }]
        }],
        generationConfig: Some(GenerationConfig {
            maxOutputTokens: Some(1024),
            temperature: Some(0.7),
        }),
    };
    
    // Create HTTP client with timeout
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    
    // Make the API request
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key={}", api_key);
    let response = client
        .post(url)
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
    let gemini_response: GeminiResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse API response: {}", e))?;
    
    // Extract the AI's message
    gemini_response
        .candidates
        .first()
        .and_then(|c| c.content.parts.first())
        .map(|p| p.text.clone())
        .ok_or_else(|| "No response from AI".to_string())
}

struct ApiKeyState(Mutex<Option<String>>);

fn main() {
    tauri::Builder::default()
        .manage(ApiKeyState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            submit_observation,
            submit_to_copilot,
            get_cached_key,
            store_api_key,
            chat_with_ai
        ])
        .setup(|app| {
            let app_handle = app.handle();
            let key_state = app_handle.state::<ApiKeyState>();
            let path = app.path_resolver().app_data_dir().unwrap_or_default().join("key.cache");
            if let Ok(cached) = std::fs::read_to_string(path) {
                *key_state.0.lock().unwrap() = Some(cached.trim().to_string());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
