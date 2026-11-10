//! `remote-exec run`: the data plane. Its stdin, stdout and stderr are the user's. It
//! hands them to the session, which starts the command on them, then waits and exits with the
//! command's status. Signals it receives are forwarded to the command's process group.

use crate::proto::exec_capnp::{run_to_session, session_to_run};
use crate::proto::{from_bytes, to_bytes};
use crate::sock;
use crate::util::{check_id, run_dir, unhex};
use capnp::message::Builder;
use std::os::fd::AsRawFd;

const FAILED: i32 = 125;

enum Reply {
    Accepted,
    Exited(i32),
    Reject(String),
    Closed,
}

fn reply(fd: i32) -> Reply {
    match sock::recv(fd) {
        Ok((bytes, _)) if bytes.is_empty() => Reply::Closed,
        Ok((bytes, _)) => {
            let Ok(message) = from_bytes(&bytes) else {
                return Reply::Closed;
            };
            let Ok(root) = message.get_root::<session_to_run::Reader>() else {
                return Reply::Closed;
            };
            match root.which() {
                Ok(session_to_run::Which::Accepted(())) => Reply::Accepted,
                Ok(session_to_run::Which::Exited(code)) => Reply::Exited(code),
                Ok(session_to_run::Which::Reject(text)) => Reply::Reject(
                    text.ok()
                        .and_then(|t| t.to_str().ok().map(String::from))
                        .unwrap_or_default(),
                ),
                Err(_) => Reply::Closed,
            }
        }
        Err(_) => Reply::Closed,
    }
}

pub fn main(session: &str, token: &str) -> i32 {
    if let Err(e) = check_id(session) {
        eprintln!("remote-exec run: {e}");
        return FAILED;
    }
    let Some(token) = unhex(token) else {
        eprintln!("remote-exec run: the token isn't hex");
        return FAILED;
    };
    // Catch signals from the start, so one sent while attaching is forwarded once the command runs
    // rather than killing us with the default action.
    let mut signals = {
        use signal_hook::consts::*;
        match signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2]) {
            Ok(signals) => signals,
            Err(e) => {
                eprintln!("remote-exec run: can't catch signals: {e}");
                return FAILED;
            }
        }
    };
    let conn = match sock::connect_to(&run_dir().join(format!("{session}.sock"))) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("remote-exec run: can't reach session {session}: {e}");
            return FAILED;
        }
    };
    let mut message = Builder::new_default();
    message.init_root::<run_to_session::Builder>().set_attach(&token);
    if let Err(e) = sock::send(conn.as_raw_fd(), &to_bytes(&message), &[0, 1, 2]) {
        eprintln!("remote-exec run: attaching failed: {e}");
        return FAILED;
    }
    match reply(conn.as_raw_fd()) {
        Reply::Accepted => {}
        Reply::Exited(code) => return code,
        Reply::Reject(why) => {
            eprintln!("remote-exec: {why}");
            return FAILED;
        }
        Reply::Closed => {
            eprintln!("remote-exec run: the session closed");
            return FAILED;
        }
    }
    // The command has the descriptors now. Close our copies, so the target sees EOF on stdout and
    // stderr exactly when the command and its children are done with them.
    unsafe {
        let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
        if null >= 0 {
            libc::dup2(null, 0);
            libc::dup2(null, 1);
            libc::dup2(null, 2);
            if null > 2 {
                libc::close(null);
            }
        }
    }
    // Forward catchable signals sent to us through the target's kill().
    {
        let fd = conn.as_raw_fd();
        std::thread::spawn(move || {
            for signal in signals.forever() {
                let mut message = Builder::new_default();
                message.init_root::<run_to_session::Builder>().set_signal(signal as u8);
                let _ = sock::send(fd, &to_bytes(&message), &[]);
            }
        });
    }
    loop {
        match reply(conn.as_raw_fd()) {
            Reply::Exited(code) => return code,
            Reply::Accepted => continue,
            Reply::Reject(_) | Reply::Closed => return FAILED,
        }
    }
}
