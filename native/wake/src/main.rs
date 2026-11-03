// Resident wake helper. Enumerates capture devices and (later) listens through the
// same System.Speech engine the PowerShell host uses.

mod devices;
mod json;

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments
        .iter()
        .any(|argument| argument == "--list-devices")
    {
        let devices = devices::list();
        json::emit(&json::devices_event(&devices));
        return;
    }
    json::emit(&json::error_event("unavailable"));
}
