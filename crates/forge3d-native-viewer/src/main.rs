fn main() {
    if let Err(error) = forge3d_native_viewer::run_cli(std::env::args().skip(1)) {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
