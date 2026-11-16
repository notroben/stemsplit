mod sidecar;

use sidecar::{spawn_sidecar, SidecarState};
use tauri::{Manager, RunEvent, WindowEvent};

#[tauri::command]
fn get_sidecar_port(state: tauri::State<'_, SidecarState>) -> u16 {
    state.port
}

#[tauri::command]
fn get_sidecar_url(state: tauri::State<'_, SidecarState>) -> String {
    state.url()
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let sidecar_state = spawn_sidecar().map_err(std::io::Error::other)?;
            app.manage(sidecar_state);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                if let Some(state) = window.app_handle().try_state::<SidecarState>() {
                    state.kill();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![get_sidecar_port, get_sidecar_url])
        .build(tauri::generate_context!())
        .expect("error while building StemSplit Tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<SidecarState>() {
                state.kill();
            }
        }
    });
}
