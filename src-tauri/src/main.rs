// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn submit_observation(payload: String) -> String {
    // Basic handler that returns a success string to the React frontend
    format!("Observation received successfully: {}", payload)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![submit_observation])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
