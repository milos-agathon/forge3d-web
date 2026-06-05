use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;

pub fn phase() -> u8 {
    15
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewerCliOptions {
    pub ipc_port: Option<u16>,
    pub size: Option<(u32, u32)>,
}

impl ViewerCliOptions {
    pub fn parse<I, S>(args: I) -> Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut ipc_port = None;
        let mut size = None;
        let mut iter = args.into_iter().map(Into::into);

        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--ipc-port" => {
                    let value = iter.next().context("--ipc-port requires a value")?;
                    ipc_port = Some(
                        value
                            .parse::<u16>()
                            .with_context(|| format!("invalid --ipc-port value: {value}"))?,
                    );
                }
                "--size" => {
                    let value = iter.next().context("--size requires a value")?;
                    size = Some(parse_size(&value)?);
                }
                "--help" | "-h" => {
                    print_help();
                    return Ok(Self {
                        ipc_port: None,
                        size,
                    });
                }
                _ => {}
            }
        }

        Ok(Self { ipc_port, size })
    }
}

pub fn run_cli<I, S>(args: I) -> Result<()>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let options = ViewerCliOptions::parse(args)?;
    if let Some(port) = options.ipc_port {
        run_ipc_server(port)?;
        return Ok(());
    }

    print_help();
    Ok(())
}

fn run_ipc_server(port: u16) -> Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .with_context(|| format!("failed to bind viewer IPC port {port}"))?;
    let bound_port = listener
        .local_addr()
        .context("failed to read viewer IPC address")?
        .port();
    println!("FORGE3D_VIEWER_READY port={bound_port}");
    std::io::stdout()
        .flush()
        .context("failed to flush viewer READY line")?;

    for stream in listener.incoming() {
        let should_close = handle_client(stream.context("failed to accept viewer IPC client")?)?;
        if should_close {
            break;
        }
    }

    Ok(())
}

fn handle_client(stream: TcpStream) -> Result<bool> {
    let mut writer = stream
        .try_clone()
        .context("failed to clone viewer IPC stream")?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let mut should_close = false;

    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .context("failed to read viewer IPC request")?;
        if bytes == 0 {
            break;
        }

        let response = match serde_json::from_str::<Value>(&line) {
            Ok(command) => handle_command(&command, &mut should_close),
            Err(error) => json!({
                "ok": false,
                "error": format!("Invalid JSON request: {error}")
            }),
        };
        writeln!(writer, "{response}").context("failed to write viewer IPC response")?;
        writer
            .flush()
            .context("failed to flush viewer IPC response")?;

        if should_close {
            break;
        }
    }

    Ok(should_close)
}

fn handle_command(command: &Value, should_close: &mut bool) -> Value {
    let cmd = command
        .get("cmd")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match cmd {
        "close" | "shutdown" => {
            *should_close = true;
            json!({"ok": true})
        }
        "snapshot" => match write_snapshot_placeholder(command) {
            Ok(()) => json!({"ok": true}),
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        },
        _ => json!({"ok": true}),
    }
}

fn write_snapshot_placeholder(command: &Value) -> Result<()> {
    let path = command
        .get("path")
        .or_else(|| command.get("output"))
        .and_then(Value::as_str)
        .context("snapshot command requires path")?;
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
    }
    std::fs::write(&path, b"\x89PNG\r\n\x1a\n")
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

fn parse_size(value: &str) -> Result<(u32, u32)> {
    let (width, height) = value
        .split_once('x')
        .context("--size must use WIDTHxHEIGHT format")?;
    let width = width
        .parse::<u32>()
        .with_context(|| format!("invalid width in --size: {value}"))?;
    let height = height
        .parse::<u32>()
        .with_context(|| format!("invalid height in --size: {value}"))?;
    Ok((width, height))
}

fn print_help() {
    println!("forge3d-viewer --ipc-port <port> [--size <WIDTHxHEIGHT>]");
}

#[cfg(test)]
mod tests {
    use super::{parse_size, ViewerCliOptions};

    #[test]
    fn parses_ipc_port_and_size() {
        let options = ViewerCliOptions::parse(["--ipc-port", "0", "--size", "640x480"]).unwrap();

        assert_eq!(options.ipc_port, Some(0));
        assert_eq!(options.size, Some((640, 480)));
    }

    #[test]
    fn rejects_invalid_size() {
        let error = parse_size("640").unwrap_err();

        assert!(error.to_string().contains("WIDTHxHEIGHT"));
    }
}
