//! `remote-exec session`: the control plane of one exec() call.
//!
//! Requests arrive on stdin and responses leave on stdout, strictly in order. The session holds
//! the lock, applies the push, records the pull baseline, starts the command on the descriptors
//! `remote-exec run` hands over, supervises it, and streams the pull. When stdin closes, for whatever
//! reason, it kills everything the command started, removes its socket and exits; the kernel
//! drops the lock.

use crate::lock::{self, Lock};
use crate::procs::{self, Spec};
use crate::proto::exec_capnp::{request, response, run_to_session, session_to_run};
use crate::proto::{self, read_entry, text_list, to_bytes, write_entry, PROTOCOL};
use crate::sock;
use crate::sync::{Baseline, Push, Report};
use crate::util::{check_id, log, parse_owner, private_dir, random_token, run_dir, Error, Res};
use crate::walk::{Kind, Selector};
use capnp::message::Builder;
use std::fs;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

/// How long the session waits for `remote-exec run` after `Prepared`. `REMOTE_EXEC_ATTACH_TIMEOUT_MS`
/// overrides it, for tests.
fn attach_timeout_ms() -> i32 {
    std::env::var("REMOTE_EXEC_ATTACH_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(30_000)
}
const CHUNK: usize = 1024 * 1024;
const GRACE: Duration = Duration::from_secs(2);

struct Running {
    pgid: i32,
    done: Arc<AtomicBool>,
    supervisor: Option<JoinHandle<i32>>,
}

struct Session {
    id: String,
    out: BufWriter<io::Stdout>,
    root: Option<String>,
    lock: Option<Lock>,
    listener: Option<OwnedFd>,
    socket_path: PathBuf,
    push: Option<Push>,
    token: Option<[u8; 16]>,
    spec: Option<Spec>,
    baseline: Option<Baseline>,
    running: Option<Running>,
}

enum Flow {
    Continue,
    Exit,
}

pub fn version() -> std::io::Result<String> {
    let hash = crate::util::hex(&crate::util::sha256_file(std::path::Path::new("/proc/self/exe"))?);
    Ok(format!(
        "remote-exec {} protocol {} sha256:{}",
        env!("CARGO_PKG_VERSION"),
        PROTOCOL,
        hash
    ))
}

pub fn main(id: &str) -> i32 {
    if let Err(e) = check_id(id) {
        eprintln!("remote-exec session: {e}");
        return 2;
    }
    unsafe {
        libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
    }
    let mut session = Session {
        id: id.to_string(),
        out: BufWriter::new(io::stdout()),
        root: None,
        lock: None,
        listener: None,
        socket_path: run_dir().join(format!("{id}.sock")),
        push: None,
        token: None,
        spec: None,
        baseline: None,
        running: None,
    };
    let mut stdin = BufReader::with_capacity(CHUNK + 4096, io::stdin());
    let code = loop {
        let message = match capnp::serialize::try_read_message(&mut stdin, proto::reader_options()) {
            Ok(Some(m)) => m,
            Ok(None) => {
                log("host-gone", "stdin closed");
                break 0;
            }
            Err(e) => {
                log("bad-message", &e.to_string());
                let _ = session.error(&Error::protocol(e.to_string()));
                break 1;
            }
        };
        let flow = message
            .get_root::<request::Reader>()
            .map_err(Error::from)
            .and_then(|req| session.handle(req));
        match flow {
            Ok(Flow::Continue) => {}
            Ok(Flow::Exit) => break 0,
            Err(e) => {
                log("error", &e.to_string());
                if session.error(&e).is_err() || e.code == "protocol" {
                    break 1;
                }
            }
        }
    };
    session.cleanup();
    // Exit now, even if the host still holds our stdin open; the lock goes with the process.
    code
}

impl Session {
    fn respond(&mut self, build: impl FnOnce(response::Builder)) -> Res<()> {
        let mut message = Builder::new_default();
        build(message.init_root::<response::Builder>());
        capnp::serialize::write_message(&mut self.out, &message).map_err(Error::from)?;
        self.out.flush()?;
        Ok(())
    }

    fn error(&mut self, e: &Error) -> Res<()> {
        self.respond(|r| {
            let mut err = r.init_error();
            err.set_code(e.code);
            err.set_message(e.message.as_str());
            err.set_errno(e.errno);
        })
    }

    fn root(&self) -> Res<&str> {
        self.root
            .as_deref()
            .ok_or_else(|| Error::protocol("Begin must come first"))
    }

    fn handle(&mut self, req: request::Reader) -> Res<Flow> {
        use request::Which;
        match req.which()? {
            Which::Begin(begin) => {
                let begin = begin?;
                if self.root.is_some() {
                    return Err(Error::protocol("Begin twice"));
                }
                if begin.get_protocol() != PROTOCOL {
                    return Err(Error::protocol(format!(
                        "protocol {} isn't supported; this remote-exec speaks {}",
                        begin.get_protocol(),
                        PROTOCOL
                    )));
                }
                let id = begin.get_id()?.to_str()?;
                if id != self.id {
                    return Err(Error::protocol(format!(
                        "Begin for session {id:?}, but this is {:?}",
                        self.id
                    )));
                }
                let root = begin.get_root()?.to_str()?.to_string();
                if !root.starts_with('/') {
                    return Err(Error::protocol("root must be absolute"));
                }
                let mut waited = 0u32;
                if begin.get_lock() {
                    let lock = lock::acquire(&root, Duration::from_millis(begin.get_lock_timeout_ms() as u64))?;
                    waited = lock.waited.as_millis() as u32;
                    self.lock = Some(lock);
                }
                fs::create_dir_all(&root)?;
                private_dir(&run_dir())?;
                self.listener = Some(sock::listen_at(&self.socket_path)?);
                self.root = Some(root);
                let version = version()?;
                self.respond(|r| {
                    let mut b = r.init_begun();
                    b.set_protocol(PROTOCOL);
                    b.set_version(version.as_str());
                    b.set_arch(std::env::consts::ARCH);
                    b.set_lock_wait_ms(waited);
                })?;
            }
            Which::Push(push) => {
                let push = push?;
                let root = self.root()?.to_string();
                if self.push.is_some() || self.token.is_some() {
                    return Err(Error::protocol("Push out of order"));
                }
                let selection = push.get_selection()?;
                let globs = text_list(selection.get_globs()?)?;
                proto::check_globs(&globs)?;
                let mut manifest = Vec::new();
                for entry in push.get_manifest()?.iter() {
                    manifest.push(read_entry(entry)?);
                }
                let owner = parse_owner(push.get_owner()?.to_str()?)?;
                let (state, want) = Push::begin(&root, Selector::new(&globs)?, manifest, owner)?;
                self.push = Some(state);
                self.respond(|r| {
                    let mut list = r.init_want(want.len() as u32);
                    for (i, w) in want.iter().enumerate() {
                        list.set(i as u32, *w);
                    }
                })?;
            }
            Which::Chunk(chunk) => {
                let chunk = chunk?;
                let push = self
                    .push
                    .as_mut()
                    .ok_or_else(|| Error::protocol("Chunk without Push"))?;
                push.chunk(chunk.get_index(), chunk.get_data()?, chunk.get_last())?;
            }
            Which::PushEnd(()) => {
                let push = self
                    .push
                    .take()
                    .ok_or_else(|| Error::protocol("PushEnd without Push"))?;
                let report = push.end()?;
                self.respond(|r| write_report(r.init_push_report(), &report))?;
            }
            Which::Prepare(prepare) => {
                let prepare = prepare?;
                let root = self.root()?.to_string();
                if self.token.is_some() || self.push.is_some() {
                    return Err(Error::protocol("Prepare out of order"));
                }
                let spec = prepare.get_spec()?;
                let mut given = Vec::new();
                for var in spec.get_env()?.iter() {
                    given.push((
                        var.get_name()?.to_str()?.to_string(),
                        var.get_value()?.to_str()?.to_string(),
                    ));
                }
                let spec = Spec {
                    argv: text_list(spec.get_argv()?)?,
                    cwd: spec.get_cwd()?.to_str()?.to_string(),
                    env: procs::environment(&procs::image_environ()?, &given)?,
                    user: spec.get_user()?.to_str()?.to_string(),
                };
                if spec.argv.is_empty() {
                    return Err(Error::protocol("argv is empty"));
                }
                parse_owner(&spec.user)?;
                let pull = prepare.get_pull()?;
                let globs = text_list(pull.get_globs()?)?;
                proto::check_globs(&globs)?;
                if !globs.is_empty() {
                    self.baseline = Some(Baseline::take(&root, Selector::new(&globs)?)?);
                }
                let token = random_token()?;
                self.token = Some(token);
                self.spec = Some(spec);
                self.respond(|mut r| r.set_prepared(&token))?;
            }
            Which::AwaitStart(()) => {
                let token = self.token.ok_or_else(|| Error::protocol("AwaitStart before Prepare"))?;
                if self.running.is_some() {
                    return Err(Error::protocol("AwaitStart twice"));
                }
                let pid = self.attach(token)?;
                self.respond(|mut r| r.set_started(pid as u32))?;
            }
            Which::Signal(signal) => {
                if let Some(running) = &self.running {
                    if !running.done.load(Ordering::SeqCst) && (1..=64).contains(&signal) {
                        procs::signal_tree(running.pgid, signal as i32, signal as i32 == libc::SIGKILL);
                    }
                }
                self.respond(|mut r| r.set_signaled(()))?;
            }
            Which::Pull(()) => {
                self.pull()?;
            }
            Which::Close(()) => {
                self.respond(|mut r| r.set_closed(()))?;
                return Ok(Flow::Exit);
            }
        }
        Ok(Flow::Continue)
    }

    /// Accept `remote-exec run`, check its token, and start the command on its descriptors.
    fn attach(&mut self, token: [u8; 16]) -> Res<i32> {
        let listener = self.listener.as_ref().ok_or_else(|| Error::protocol("no socket"))?;
        let conn = loop {
            let conn = sock::accept_within(listener, attach_timeout_ms())?;
            let (bytes, fds) = match sock::recv(conn.as_raw_fd()) {
                Ok(x) => x,
                Err(_) => continue,
            };
            let attach_token = proto::from_bytes(&bytes).ok().and_then(|m| {
                let msg = m.get_root::<run_to_session::Reader>().ok()?;
                match msg.which().ok()? {
                    run_to_session::Which::Attach(t) => t.ok().map(|t| t.to_vec()),
                    _ => None,
                }
            });
            if attach_token.as_deref() != Some(&token[..]) || fds.len() != 3 {
                log("reject", "a connection with the wrong token or descriptors");
                let _ = send_to_run(&conn, |mut m| m.set_reject("wrong token"));
                continue;
            }
            let fds: [OwnedFd; 3] = fds.try_into().unwrap();
            // The token is single-use.
            self.token = Some(random_token()?);
            let spec = self.spec.as_ref().unwrap();
            match procs::spawn(spec, fds) {
                Ok(pid) => break (conn, pid),
                Err(e) => {
                    let _ = send_to_run(&conn, |mut m| m.set_reject(e.message.as_str()));
                    return Err(e);
                }
            }
        };
        let (conn, pid) = conn;
        send_to_run(&conn, |mut m| m.set_accepted(()))?;
        let done = Arc::new(AtomicBool::new(false));
        let conn = Arc::new(conn);

        // run → session: forwarded signals, or EOF when run dies.
        {
            let conn = conn.clone();
            let done = done.clone();
            std::thread::spawn(move || loop {
                match sock::recv(conn.as_raw_fd()) {
                    Ok((bytes, _)) if bytes.is_empty() => {
                        if !done.load(Ordering::SeqCst) {
                            log("run-gone", "killing the command");
                            procs::signal_tree(pid, libc::SIGKILL, true);
                        }
                        break;
                    }
                    Ok((bytes, _)) => {
                        let signal = proto::from_bytes(&bytes).ok().and_then(|m| {
                            match m.get_root::<run_to_session::Reader>().ok()?.which().ok()? {
                                run_to_session::Which::Signal(s) => Some(s),
                                _ => None,
                            }
                        });
                        if let Some(s) = signal {
                            if !done.load(Ordering::SeqCst) && (1..=64).contains(&s) {
                                procs::signal_tree(pid, s as i32, s as i32 == libc::SIGKILL);
                            }
                        }
                    }
                    Err(_) => break,
                }
            });
        }

        // Supervisor: wait for the command, end what it left behind, tell run the status.
        let supervisor = {
            let done = done.clone();
            let conn = conn.clone();
            std::thread::spawn(move || {
                let code = procs::wait_exit(pid);
                procs::terminate_rest(pid, GRACE);
                done.store(true, Ordering::SeqCst);
                let _ = send_to_run(&conn, |mut m| m.set_exited(code));
                code
            })
        };
        self.running = Some(Running {
            pgid: pid,
            done,
            supervisor: Some(supervisor),
        });
        Ok(pid)
    }

    fn pull(&mut self) -> Res<()> {
        let running = self
            .running
            .as_mut()
            .ok_or_else(|| Error::protocol("Pull before the command started"))?;
        // Pull only once the command and everything it left behind have stopped.
        if let Some(handle) = running.supervisor.take() {
            let _ = handle.join();
        }
        let changes = match &self.baseline {
            Some(baseline) => baseline.changes(),
            None => crate::sync::Changes {
                changed: Vec::new(),
                deleted: Vec::new(),
                skipped: Vec::new(),
            },
        };
        self.respond(|r| {
            let mut c = r.init_changes();
            let mut list = c.reborrow().init_changed(changes.changed.len() as u32);
            for (i, entry) in changes.changed.iter().enumerate() {
                write_entry(list.reborrow().get(i as u32), entry);
            }
            let mut deleted = c.reborrow().init_deleted(changes.deleted.len() as u32);
            for (i, path) in changes.deleted.iter().enumerate() {
                deleted.set(i as u32, path.as_str());
            }
            write_skipped(c.init_skipped(changes.skipped.len() as u32), &changes.skipped);
        })?;
        let mut report = Report::default();
        let root = PathBuf::from(self.root()?);
        for (index, entry) in changes.changed.iter().enumerate() {
            if entry.kind != Kind::File {
                report.written += 1;
                continue;
            }
            let path = root.join(&entry.path);
            let mut file = match open_nofollow(&path) {
                Ok(f) => f,
                Err(e) => {
                    // Gone or swapped since the walk: send it empty and report it.
                    report.skipped.push((entry.path.clone(), format!("unreadable: {e}")));
                    self.send_chunk(index as u32, &[], true)?;
                    continue;
                }
            };
            // Whole chunks until a short one, which may be empty, marks the end.
            let mut buf = vec![0u8; CHUNK];
            loop {
                let n = read_full(&mut file, &mut buf)?;
                let last = n < CHUNK;
                self.send_chunk(index as u32, &buf[..n], last)?;
                report.bytes += n as u64;
                if last {
                    break;
                }
            }
            report.written += 1;
        }
        report.deleted = changes.deleted.clone();
        self.respond(|r| write_report(r.init_pull_end(), &report))
    }

    fn send_chunk(&mut self, index: u32, data: &[u8], last: bool) -> Res<()> {
        self.respond(|r| {
            let mut c = r.init_chunk();
            c.set_index(index);
            c.set_data(data);
            c.set_last(last);
        })
    }

    fn cleanup(&mut self) {
        if let Some(running) = &self.running {
            if !running.done.load(Ordering::SeqCst) {
                log("cleanup", "killing the command");
                procs::kill_all(running.pgid);
            }
        }
        if self.listener.take().is_some() {
            let _ = fs::remove_file(&self.socket_path);
        }
        self.lock = None;
    }
}

fn send_to_run(conn: &OwnedFd, build: impl FnOnce(session_to_run::Builder)) -> Res<()> {
    let mut message = Builder::new_default();
    build(message.init_root::<session_to_run::Builder>());
    sock::send(conn.as_raw_fd(), &to_bytes(&message), &[])
}

fn write_report(mut b: crate::proto::exec_capnp::report::Builder, report: &Report) {
    b.set_written(report.written);
    b.set_bytes(report.bytes);
    let mut deleted = b.reborrow().init_deleted(report.deleted.len() as u32);
    for (i, p) in report.deleted.iter().enumerate() {
        deleted.set(i as u32, p.as_str());
    }
    write_skipped(b.init_skipped(report.skipped.len() as u32), &report.skipped);
}

fn write_skipped(
    mut list: capnp::struct_list::Builder<crate::proto::exec_capnp::skipped::Owned>,
    skipped: &[(String, String)],
) {
    for (i, (path, reason)) in skipped.iter().enumerate() {
        let mut s = list.reborrow().get(i as u32);
        s.set_path(path.as_str());
        s.set_reason(reason.as_str());
    }
}

fn open_nofollow(path: &std::path::Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

fn read_full(file: &mut fs::File, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = file.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}
