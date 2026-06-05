use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::Duration;

#[test]
fn viewer_binary_starts_ipc_and_accepts_close() {
    let binary = env!("CARGO_BIN_EXE_forge3d-viewer");
    let mut child = Command::new(binary)
        .args(["--ipc-port", "0", "--size", "64x64"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn forge3d-viewer");

    let stdout = child.stdout.take().expect("viewer stdout must be piped");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .expect("failed to read viewer READY line");

    let port = parse_ready_port(&line)
        .unwrap_or_else(|| panic!("missing FORGE3D_VIEWER_READY line, got {line:?}"));
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("failed to connect to viewer");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("failed to set viewer read timeout");
    stream
        .write_all(br#"{"cmd":"close"}"#)
        .expect("failed to send close command");
    stream.write_all(b"\n").expect("failed to send newline");

    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .expect("failed to read close response");
    assert!(
        response.contains(r#""ok":true"#),
        "viewer close response was {response:?}"
    );

    let status = child.wait().expect("failed to wait for viewer exit");
    assert!(status.success(), "viewer exited with {status}");
}

fn parse_ready_port(line: &str) -> Option<u16> {
    let prefix = "FORGE3D_VIEWER_READY port=";
    let start = line.find(prefix)? + prefix.len();
    line[start..].trim().parse::<u16>().ok()
}
