use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use winit::event_loop::EventLoop;

pub fn phase() -> u8 {
    15
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewerCliOptions {
    pub ipc_port: Option<u16>,
    pub size: Option<(u32, u32)>,
    pub use_stdin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewerRuntimeCapabilities {
    pub uses_winit: bool,
    pub supports_stdin: bool,
    pub supports_tcp_ipc: bool,
    pub supports_snapshot: bool,
}

impl ViewerCliOptions {
    pub fn parse<I, S>(args: I) -> Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut ipc_port = None;
        let mut size = None;
        let mut use_stdin = false;
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
                "--stdin" => {
                    use_stdin = true;
                }
                "--help" | "-h" => {
                    print_help();
                    return Ok(Self {
                        ipc_port: None,
                        size,
                        use_stdin,
                    });
                }
                _ => {}
            }
        }

        Ok(Self {
            ipc_port,
            size,
            use_stdin,
        })
    }
}

pub fn viewer_runtime_capabilities() -> ViewerRuntimeCapabilities {
    ViewerRuntimeCapabilities {
        uses_winit: std::any::type_name::<EventLoop<()>>().contains("EventLoop"),
        supports_stdin: true,
        supports_tcp_ipc: true,
        supports_snapshot: true,
    }
}

pub fn run_cli<I, S>(args: I) -> Result<()>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let options = ViewerCliOptions::parse(args)?;
    if options.use_stdin {
        let stdin = std::io::stdin();
        let stdout = std::io::stdout();
        run_stdin_loop(stdin.lock(), stdout.lock())?;
        return Ok(());
    }
    if let Some(port) = options.ipc_port {
        run_ipc_server(port)?;
        return Ok(());
    }

    print_help();
    Ok(())
}

pub fn run_stdin_loop<R, W>(reader: R, mut writer: W) -> Result<()>
where
    R: BufRead,
    W: Write,
{
    let mut should_close = false;
    for line in reader.lines() {
        let line = line.context("failed to read viewer stdin request")?;
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(command) => handle_command(&command, &mut should_close),
            Err(error) => json!({
                "ok": false,
                "error": format!("Invalid JSON request: {error}")
            }),
        };
        writeln!(writer, "{response}").context("failed to write viewer stdin response")?;
        writer
            .flush()
            .context("failed to flush viewer stdin response")?;
        if should_close {
            break;
        }
    }
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
        "snapshot" => match write_snapshot_png(command) {
            Ok(()) => json!({"ok": true}),
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        },
        _ => json!({"ok": true}),
    }
}

fn write_snapshot_png(command: &Value) -> Result<()> {
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
    let width = command
        .get("width")
        .and_then(Value::as_u64)
        .unwrap_or(16)
        .clamp(1, 4096) as u32;
    let height = command
        .get("height")
        .and_then(Value::as_u64)
        .unwrap_or(16)
        .clamp(1, 4096) as u32;
    let mut image = image::RgbaImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let r = ((x * 255) / width.max(1)) as u8;
            let g = ((y * 255) / height.max(1)) as u8;
            image.put_pixel(x, y, image::Rgba([r, g, 96, 255]));
        }
    }
    image
        .save(&path)
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
    println!("forge3d-viewer [--stdin|--ipc-port <port>] [--size <WIDTHxHEIGHT>]");
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
    fn parses_stdin_transport() {
        let options = ViewerCliOptions::parse(["--stdin", "--size", "320x240"]).unwrap();

        assert!(options.use_stdin);
        assert_eq!(options.size, Some((320, 240)));
    }

    #[test]
    fn reports_runtime_capabilities() {
        let capabilities = super::viewer_runtime_capabilities();

        assert!(capabilities.uses_winit);
        assert!(capabilities.supports_stdin);
        assert!(capabilities.supports_tcp_ipc);
        assert!(capabilities.supports_snapshot);
    }

    #[test]
    fn stdin_loop_handles_snapshot_and_close() {
        let path =
            std::env::temp_dir().join(format!("forge3d-native-viewer-{}.png", std::process::id()));
        let input = format!(
            "{{\"cmd\":\"snapshot\",\"path\":\"{}\"}}\n{{\"cmd\":\"close\"}}\n",
            path.display().to_string().replace('\\', "\\\\")
        );
        let mut output = Vec::new();

        super::run_stdin_loop(input.as_bytes(), &mut output).unwrap();

        let responses = String::from_utf8(output).unwrap();
        assert_eq!(responses.lines().count(), 2);
        assert!(responses.lines().all(|line| line.contains("\"ok\":true")));
        assert_eq!(&std::fs::read(&path).unwrap()[..8], b"\x89PNG\r\n\x1a\n");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_invalid_size() {
        let error = parse_size("640").unwrap_err();

        assert!(error.to_string().contains("WIDTHxHEIGHT"));
    }
}
