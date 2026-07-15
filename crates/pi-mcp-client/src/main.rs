use std::env;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const SOCKET_ENV: &str = "PI_RECIPES_MCP_DAEMON_SOCKET";
const TOKEN_ENV: &str = "PI_RECIPES_MCP_DAEMON_TOKEN";
const FINGERPRINT_ENV: &str = "PI_RECIPES_MCP_DAEMON_FINGERPRINT";
const FALLBACK_EXIT_CODE: i32 = 75;

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

fn request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("native-{}-{nanos:x}-{sequence:x}", process::id())
}

fn command_needs_stdin(args: &[String]) -> bool {
    if args
        .windows(2)
        .any(|pair| pair[0] == "--json" && pair[1] == "-")
    {
        return true;
    }
    if args.first().map(String::as_str) != Some("run") {
        return false;
    }
    let mut index = 1;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--json-errors" {
            index += 1;
            continue;
        }
        if arg == "--var" {
            index += 2;
            continue;
        }
        if arg.starts_with("--var=") {
            index += 1;
            continue;
        }
        return false;
    }
    true
}

fn read_stdin(args: &[String]) -> io::Result<String> {
    if !command_needs_stdin(args) {
        return Ok(String::new());
    }
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    Ok(input)
}

#[cfg(unix)]
mod platform {
    use super::*;
    use signal_hook::consts::signal::{SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::thread;

    fn connect(socket_path: &str) -> io::Result<UnixStream> {
        UnixStream::connect(socket_path)
    }

    fn send_line(stream: &mut UnixStream, value: &Value) -> io::Result<()> {
        serde_json::to_writer(&mut *stream, value)?;
        stream.write_all(b"\n")?;
        stream.flush()
    }

    fn spawn_cancel_handler(
        socket_path: String,
        token: String,
        request_id: String,
        interrupted: Arc<AtomicBool>,
    ) {
        thread::spawn(move || {
            let Ok(mut signals) = Signals::new([SIGINT, SIGTERM]) else {
                return;
            };
            if signals.forever().next().is_some() {
                interrupted.store(true, Ordering::Relaxed);
                if let Ok(mut stream) = connect(&socket_path) {
                    let cancel = json!({
                        "type": "cancel",
                        "id": super::request_id(),
                        "token": token,
                        "requestId": request_id,
                    });
                    let _ = send_line(&mut stream, &cancel);
                }
            }
        });
    }

    fn send_cancel(socket_path: &str, token: &str, request_id: &str) {
        if let Ok(mut stream) = connect(socket_path) {
            let cancel = json!({
                "type": "cancel",
                "id": super::request_id(),
                "token": token,
                "requestId": request_id,
            });
            let _ = send_line(&mut stream, &cancel);
        }
    }

    pub fn run(args: Vec<String>) -> i32 {
        let socket_path = match env::var(SOCKET_ENV) {
            Ok(value) if !value.is_empty() => value,
            _ => return FALLBACK_EXIT_CODE,
        };
        let token = match env::var(TOKEN_ENV) {
            Ok(value) if !value.is_empty() => value,
            _ => return FALLBACK_EXIT_CODE,
        };
        let fingerprint = match env::var(FINGERPRINT_ENV) {
            Ok(value) if !value.is_empty() => value,
            _ => return FALLBACK_EXIT_CODE,
        };
        let stdin = match read_stdin(&args) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("mcp: failed to read stdin: {error}");
                return 1;
            }
        };
        let id = request_id();
        let mut stream = match connect(&socket_path) {
            Ok(stream) => stream,
            Err(_) => return FALLBACK_EXIT_CODE,
        };
        let request = json!({
            "type": "execute",
            "id": id,
            "token": token,
            "fingerprint": fingerprint,
            "args": args,
            "stdin": stdin,
        });
        if send_line(&mut stream, &request).is_err() {
            return FALLBACK_EXIT_CODE;
        }
        let interrupted = Arc::new(AtomicBool::new(false));
        spawn_cancel_handler(
            socket_path.clone(),
            token.clone(),
            id.clone(),
            Arc::clone(&interrupted),
        );

        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    return if interrupted.load(Ordering::Relaxed) {
                        130
                    } else {
                        1
                    }
                }
                Ok(_) => {}
                Err(_) => {
                    return if interrupted.load(Ordering::Relaxed) {
                        130
                    } else {
                        1
                    }
                }
            }
            let envelope: Value = match serde_json::from_str(line.trim_end()) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("mcp: invalid daemon response: {error}");
                    return 1;
                }
            };
            if envelope.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                continue;
            }
            if let Some(stream_name) = envelope.get("stream").and_then(Value::as_str) {
                let data = envelope
                    .get("data")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let result = if stream_name == "stderr" {
                    io::stderr().write_all(data.as_bytes())
                } else {
                    io::stdout().write_all(data.as_bytes())
                };
                if let Err(error) = result {
                    if error.kind() == io::ErrorKind::BrokenPipe {
                        send_cancel(&socket_path, &token, &id);
                        return 0;
                    }
                    return 1;
                }
                continue;
            }
            if let Some(exit_code) = envelope.get("exitCode").and_then(Value::as_i64) {
                if interrupted.load(Ordering::Relaxed) {
                    return 130;
                }
                return exit_code.clamp(0, 255) as i32;
            }
            if let Some(error) = envelope.get("error").and_then(Value::as_str) {
                if matches!(error, "configuration_mismatch" | "daemon_unavailable") {
                    return FALLBACK_EXIT_CODE;
                }
                eprintln!("MCP daemon: {error}");
                return 1;
            }
        }
    }
}

#[cfg(not(unix))]
mod platform {
    pub fn run(_args: Vec<String>) -> i32 {
        super::FALLBACK_EXIT_CODE
    }
}

fn main() {
    process::exit(platform::run(env::args().skip(1).collect()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdin_detection_matches_cli_contract() {
        assert!(command_needs_stdin(&[
            "call".into(),
            "server.tool".into(),
            "--json".into(),
            "-".into()
        ]));
        assert!(command_needs_stdin(&["run".into()]));
        assert!(command_needs_stdin(&[
            "run".into(),
            "--json-errors".into(),
            "--var=x=1".into()
        ]));
        assert!(!command_needs_stdin(&[
            "call".into(),
            "server.tool".into(),
            "key=value".into()
        ]));
        assert!(!command_needs_stdin(&["run".into(), "workflow.js".into()]));
    }
}
