use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct SidecarState {
    pub port: u16,
    child: Mutex<Option<Child>>,
}

impl SidecarState {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn kill(&self) {
        let mut guard = match self.child.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };

        let Some(mut child) = guard.take() else {
            return;
        };

        let pid = child.id();

        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = child.wait();
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = Command::new("kill")
                .args(["-TERM", &format!("-{pid}")])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for SidecarState {
    fn drop(&mut self) {
        self.kill();
    }
}

fn allocate_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind ephemeral localhost port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read bound socket address: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn has_sidecar_entry(dir: &Path) -> bool {
    dir.join("sidecar").join("server.py").is_file()
}

fn resolve_project_root() -> Result<PathBuf, String> {
    if let Some(parent) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        if has_sidecar_entry(parent) {
            return Ok(parent.to_path_buf());
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors() {
            if has_sidecar_entry(ancestor) {
                return Ok(ancestor.to_path_buf());
            }
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors() {
            if has_sidecar_entry(ancestor) {
                return Ok(ancestor.to_path_buf());
            }
        }
    }

    Err("Could not locate sidecar/server.py relative to workspace".to_string())
}

pub fn spawn_sidecar() -> Result<SidecarState, String> {
    let port = allocate_free_port()?;
    let root = resolve_project_root()?;
    let sidecar_dir = root.join("sidecar");
    let server_py = sidecar_dir.join("server.py");

    #[cfg(target_os = "windows")]
    let python_exe = sidecar_dir.join(".venv").join("Scripts").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let python_exe = sidecar_dir.join(".venv").join("bin").join("python");

    if !python_exe.is_file() {
        return Err(format!(
            "Python sidecar venv executable not found at {}",
            python_exe.display()
        ));
    }

    let parent_pid = std::process::id().to_string();
    let port_str = port.to_string();

    let mut cmd = Command::new(&python_exe);
    cmd.arg(&server_py)
        .args(["--host", "127.0.0.1", "--port", &port_str, "--parent-pid", &parent_pid])
        .current_dir(&sidecar_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Python sidecar ({}): {e}", python_exe.display()))?;

    Ok(SidecarState {
        port,
        child: Mutex::new(Some(child)),
    })
}
