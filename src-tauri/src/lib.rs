mod sidecar;

use std::path::PathBuf;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let folder = if target.is_file() {
        target.parent().unwrap_or(&target).to_path_buf()
    } else {
        target
    };

    if !folder.exists() {
        return Err(format!("Folder does not exist: {}", folder.display()));
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg(&folder)
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&folder)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {e}"))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&folder)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {e}"))?;
    }

    Ok(())
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
        .invoke_handler(tauri::generate_handler![
            get_sidecar_port,
            get_sidecar_url,
            open_folder
        ])
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
