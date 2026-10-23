use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

// 8971/8972 stay clear of the GeoAgentPro line (GEE proxy defaults to 8765/8766)
// and of GeoLibre Desktop's 8765/8766, so the products can run side by side.
const ENGINE_PORT: u16 = 8971;
const AGENT_PORT: u16 = 8972;

#[derive(Default)]
struct Services(Vec<Child>);

impl Services {
    fn stop(&mut self) {
        for child in self.0.iter_mut().rev() {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                if matches!(child.try_wait(), Ok(None)) {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .creation_flags(0x08000000)
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        self.0.clear();
    }

    fn spawn(&mut self, command: &mut Command, state: &Path, name: &str) -> std::io::Result<()> {
        let log = File::create(state.join(format!("{name}.log")))?;
        command
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        self.0.push(command.spawn()?);
        Ok(())
    }
}

impl Drop for Services {
    fn drop(&mut self) {
        self.stop();
    }
}

fn wait_ready(port: u16, route: &str, service: &str, child: &mut Child) -> std::io::Result<()> {
    let end = Instant::now() + Duration::from_secs(30);
    while Instant::now() < end {
        if let Some(code) = child.try_wait()? {
            return Err(std::io::Error::other(format!(
                "{service} exited ({code}); inspect its log in the application data directory"
            )));
        }
        if let Ok(mut stream) =
            TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(200))
        {
            stream.set_read_timeout(Some(Duration::from_millis(500)))?;
            stream.set_write_timeout(Some(Duration::from_millis(500)))?;
            if write!(
                stream,
                "GET {route} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            )
            .is_ok()
            {
                let mut response = String::new();
                let _ = stream.take(8192).read_to_string(&mut response);
                if response.starts_with("HTTP/1.1 200") && response.contains(service) {
                    return Ok(());
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(std::io::Error::other(format!(
        "{service} did not become ready; inspect its application log"
    )))
}

// Windows verbatim paths (\\?\...) break Node's main-module resolution:
// realpathSync fails with EISDIR on the drive component. Hand the sidecars
// plain paths.
fn plain_root(path: PathBuf) -> PathBuf {
    let text = path.as_os_str().to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

fn start_services(app: &tauri::App) -> Result<Services, Box<dyn std::error::Error>> {
    for port in [ENGINE_PORT, AGENT_PORT] {
        TcpListener::bind(("127.0.0.1", port)).map_err(|_| {
            std::io::Error::other(format!(
                "Port {port} is occupied. Close the other service before launching TIPHYS."
            ))
        })?;
    }
    let state = std::env::var_os("TIPHYS_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or(app.path().app_data_dir()?);
    fs::create_dir_all(&state)?;
    let root;
    let mut engine;
    let mut agent;
    if cfg!(debug_assertions) {
        root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let python = if cfg!(windows) {
            "engine/.venv/Scripts/python.exe"
        } else {
            "engine/.venv/bin/python"
        };
        engine = Command::new(root.join(python));
        engine.args([
            "-m",
            "uvicorn",
            "main:app",
            "--app-dir",
            "engine",
            "--host",
            "127.0.0.1",
            "--port",
            &ENGINE_PORT.to_string(),
        ]);
        agent = Command::new("node");
        agent.args([
            "--import",
            "./agent/node_modules/tsx/dist/loader.mjs",
            "agent/src/server.ts",
        ]);
    } else {
        // resource_dir can be verbatim (\\?\...); that prefix breaks Node's
        // main-module resolution, so strip it before building any command.
        root = plain_root(app.path().resource_dir()?).join("runtime");
        engine = Command::new(root.join("tiphys-engine/tiphys-engine.exe"));
        agent = Command::new(root.join("node.exe"));
        agent.arg(root.join("agent.mjs"));
    }
    for command in [&mut engine, &mut agent] {
        command
            .current_dir(&root)
            .env("TIPHYS_STATE_DIR", &state)
            .env("TIPHYS_DATA_DIR", state.join("data"))
            .env("TIPHYS_PROJECT_ROOT", &root)
            .env("TIPHYS_ENGINE_URL", format!("http://127.0.0.1:{ENGINE_PORT}"))
            .env("TIPHYS_ENGINE_PORT", ENGINE_PORT.to_string())
            .env("TIPHYS_AGENT_PORT", AGENT_PORT.to_string());
    }
    let mut services = Services::default();
    services.spawn(&mut engine, &state, "engine")?;
    wait_ready(ENGINE_PORT, "/ping", "tiphys-engine", services.0.last_mut().unwrap())?;
    services.spawn(&mut agent, &state, "agent")?;
    wait_ready(AGENT_PORT, "/health", "tiphys-agent", services.0.last_mut().unwrap())?;
    Ok(services)
}

// Setup errors must reach the user, not become a fail-fast crash: a release
// build with panic=abort turns the builder's `.expect` into 0xC0000409.
fn fail_startup(app: &tauri::App, message: &str) -> ! {
    let _ = std::env::var_os("TIPHYS_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().app_data_dir().ok())
        .map(|dir| {
            fs::create_dir_all(&dir).and_then(|()| fs::write(dir.join("startup-error.log"), message))
        });
    // TIPHYS_SMOKE_TEST marks automated acceptance runs, where the blocking
    // dialog would hang the run; those read startup-error.log instead.
    if std::env::var_os("TIPHYS_SMOKE_TEST").is_none() {
        rfd::MessageDialog::new()
            .set_title("TIPHYS 启动失败")
            .set_description(&format!("TIPHYS 无法启动：\n\n{message}"))
            .set_level(rfd::MessageLevel::Error)
            .show();
    }
    std::process::exit(1);
}

#[tauri::command]
async fn pick_vector_files() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("添加矢量数据")
            .add_filter("矢量数据", &["geojson", "json", "gpkg", "shp", "zip", "fgb", "kml"])
            .pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![pick_vector_files])
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            match start_services(app) {
                Ok(services) => {
                    app.manage(Mutex::new(services));
                }
                Err(error) => {
                    fail_startup(app, &format!("{error}"));
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("TIPHYS startup failed");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<Mutex<Services>>() {
                if let Ok(mut services) = state.lock() {
                    services.stop();
                }
            }
        }
    });
}
