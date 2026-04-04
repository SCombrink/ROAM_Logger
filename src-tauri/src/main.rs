// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn submit_observation(payload: String) -> String {
    // Here we will eventually bridge to a Node.js sidecar or Rust playwright equivalent
    // to perform the actual browser automation.
    println!("Received observation: {}", payload);
    format!("Observation received successfully!")
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![submit_observation])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
