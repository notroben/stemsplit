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

#[cfg(target_os = "windows")]
fn to_explorer_path(path: &std::path::Path) -> String {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let raw = resolved.to_string_lossy();
    let without_prefix = if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(local) = raw.strip_prefix(r"\\?\") {
        local.to_string()
    } else {
        raw.into_owned()
    };
    without_prefix.replace('/', r"\")
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
        // Windows Explorer rejects forward slashes and \\?\ verbatim prefixes,
        // falling back silently to the user's Documents folder.
        let win_folder = to_explorer_path(&folder);
        Command::new("explorer.exe")
            .arg(&win_folder)
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

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::to_explorer_path;
    use std::path::Path;

    #[test]
    fn converts_forward_slashes_and_strips_verbatim_prefix() {
        let cwd = std::env::current_dir().expect("cwd");
        let posix_like = cwd.to_string_lossy().replace('\\', "/");
        let converted = to_explorer_path(Path::new(&posix_like));
        assert!(!converted.contains('/'), "unexpected forward slash in {converted}");
        assert!(!converted.starts_with(r"\\?\"), "unexpected verbatim prefix in {converted}");

        let missing = to_explorer_path(Path::new("C:/Users/example/Music/my song"));
        assert_eq!(missing, r"C:\Users\example\Music\my song");
    }
}
