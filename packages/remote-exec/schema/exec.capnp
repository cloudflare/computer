# Remote exec: the messages between the host (the Worker) and remote-exec.
#
# Serialization only, no RPC.
#
# - Session channel: exec #1's stdin carries Requests, its stdout Responses, each in the standard
#   stream framing, unpacked.
# - Run socket: one RunToSession / SessionToRun message per SOCK_SEQPACKET packet.

@0xf207ac577c32e5f0;

const protocolVersion :UInt16 = 1;

struct Entry {
  path   @0 :Text;          # relative to the root, "/"-separated, no "..", no leading "/"
  kind   @1 :Kind;
  mode   @2 :UInt32;        # permission bits
  size   @3 :UInt64;
  hash   @4 :Data;          # 32-byte SHA-256, files only
  target @5 :Text;          # symlinks only

  enum Kind {
    file @0;
    symlink @1;
  }
}

struct Selection {
  root  @0 :Text;           # absolute path in the container
  globs @1 :List(Text);     # "!" negations included
}

struct Skipped {
  path   @0 :Text;
  reason @1 :Text;
}

struct RunSpec {
  argv @0 :List(Text);
  cwd  @1 :Text;
  env  @2 :List(EnvVar);    # added to the image's environment
  user @3 :Text;            # "uid:gid" or ""

  struct EnvVar {
    name  @0 :Text;
    value @1 :Text;
  }
}

struct Chunk {
  index @0 :UInt32;         # into the push manifest, or Changes.changed for pull
  data  @1 :Data;           # at most 1 MiB
  last  @2 :Bool;
}

struct Report {
  written @0 :UInt32;
  bytes   @1 :UInt64;
  deleted @2 :List(Text);
  skipped @3 :List(Skipped);
}

struct Changes {
  changed @0 :List(Entry);
  deleted @1 :List(Text);
  skipped @2 :List(Skipped);
}

struct Request {
  union {
    begin      @0 :Begin;
    push       @1 :Push;
    chunk      @2 :Chunk;
    pushEnd    @3 :Void;
    prepare    @4 :Prepare;
    awaitStart @5 :Void;
    signal     @6 :UInt8;
    pull       @7 :Void;
    close      @8 :Void;
  }

  struct Begin {
    id            @0 :Text;
    root          @1 :Text;
    lock          @2 :Bool;
    lockTimeoutMs @3 :UInt32;
    protocol      @4 :UInt16;
  }

  struct Push {
    selection @0 :Selection;
    manifest  @1 :List(Entry);
    owner     @2 :Text;      # "uid:gid" or ""
  }

  struct Prepare {
    spec @0 :RunSpec;
    pull @1 :Selection;      # globs may be empty
  }
}

struct Response {
  union {
    begun      @0 :Begun;
    want       @1 :List(UInt32);
    pushReport @2 :Report;
    prepared   @3 :Data;     # 16-byte token
    started    @4 :UInt32;   # the command's pid
    signaled   @5 :Void;
    changes    @6 :Changes;
    chunk      @7 :Chunk;
    pullEnd    @8 :Report;
    error      @9 :Error;
    closed     @10 :Void;
  }

  struct Begun {
    protocol   @0 :UInt16;
    version    @1 :Text;
    arch       @2 :Text;
    lockWaitMs @3 :UInt32;
  }

  struct Error {
    code    @0 :Text;        # protocol, busy, attach-timeout, spawn, io, limit
    message @1 :Text;
    errno   @2 :Int32;
  }
}

struct RunToSession {
  union {
    attach @0 :Data;         # token; the packet carries fds 0, 1, 2 as SCM_RIGHTS
    signal @1 :UInt8;        # a signal run received, to forward to the command
  }
}

struct SessionToRun {
  union {
    accepted @0 :Void;       # the command started; run closes its copies of the fds
    exited   @1 :Int32;      # exit status for run to exit with
    reject   @2 :Text;       # bad token, wrong state, or spawn failure; run exits 125
  }
}
