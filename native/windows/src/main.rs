mod input;
#[cfg(windows)]
mod operations;

use std::io::{self, Read, Write};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    operations::watch_parent()?;
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: serde_json::Value =
        serde_json::from_str(&input).map_err(|_| "Invalid Windows bridge request")?;
    #[cfg(windows)]
    let result = operations::run(&request)?;
    #[cfg(not(windows))]
    let result: serde_json::Value = {
        let _ = request;
        return Err("Windows only".into());
    };
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, &result)?;
    output.write_all(b"\n")?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
