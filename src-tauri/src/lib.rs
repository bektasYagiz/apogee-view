pub mod protocol;
pub mod recorder;
pub mod udp;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let log_tx = recorder::start(app.handle());
            tauri::async_runtime::spawn(udp::listen(app.handle().clone(), log_tx));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            recorder::list_flight_logs,
            recorder::load_flight_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
