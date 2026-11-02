#[cfg(windows)]
mod reader;
mod snapshot;

fn main() {
    #[cfg(windows)]
    let result = reader::run();
    #[cfg(not(windows))]
    let result: Result<(), Box<dyn std::error::Error>> =
        Err("UI Automation requires Windows".into());
    if let Err(error) = result {
        eprintln!("yu-uia: {error}");
        std::process::exit(1);
    }
}
