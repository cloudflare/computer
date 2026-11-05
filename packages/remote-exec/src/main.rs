//! remote-exec: the in-container half of @cloudflare/computer/remote-exec.
//!
//! ```text
//! remote-exec --version
//! remote-exec session --id <id>                  # exec #1: control plane, capnp on stdio
//! remote-exec run --session <id> --token <hex>   # exec #2: data plane, the user's stdio
//! ```

// Generated from schema/exec.capnp; the generated code refers to itself as `crate::exec_capnp`.
#[allow(clippy::all, dead_code, unused_parens)]
pub mod exec_capnp {
    include!(concat!(env!("OUT_DIR"), "/exec_capnp.rs"));
}

mod lock;
mod procs;
mod proto;
mod run;
mod session;
mod sock;
mod sync;
#[cfg(test)]
mod testutil;
mod util;
mod walk;

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn usage() -> i32 {
    eprintln!(
        "usage: remote-exec --version | remote-exec session --id <id> | remote-exec run --session <id> --token <hex>"
    );
    2
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("--version") => match session::version() {
            Ok(version) => {
                println!("{version}");
                0
            }
            Err(e) => {
                eprintln!("remote-exec: can't hash /proc/self/exe: {e}");
                1
            }
        },
        Some("session") => match flag(&args, "--id") {
            Some(id) => session::main(id),
            None => usage(),
        },
        Some("run") => match (flag(&args, "--session"), flag(&args, "--token")) {
            (Some(s), Some(t)) => run::main(s, t),
            _ => usage(),
        },
        _ => usage(),
    };
    std::process::exit(code);
}
