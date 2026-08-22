use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // Ensure the window is always on top without stealing keyboard focus
                let _ = window.set_always_on_top(true);
                let _ = window.set_shadow(false);

                #[cfg(target_os = "macos")]
                {
                    use tauri::Position;
                    // Position top-right on primary display
                    let _ = window.set_position(Position::Physical(tauri::PhysicalPosition {
                        x: 1050,
                        y: 40,
                    }));
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
