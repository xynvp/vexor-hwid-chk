#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    desktop_core::run(tauri::generate_context!(), desktop_core::Mode::Admin);
}
