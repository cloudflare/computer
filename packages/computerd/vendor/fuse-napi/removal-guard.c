/*
 * Removal guard for computerd's native roots. Not upstream; see PATCHES.md.
 *
 * A native root is a local-only directory bind-mounted onto the FUSE mount.
 * rmdir(2) and rename(2) of a mount point fail with EBUSY inside the VFS,
 * before FUSE is asked, so `rm -rf node_modules` empties the directory and
 * then fails on it. This installs a seccomp filter on the calling thread --
 * computerd's JavaScript main thread, which every command it spawns is forked
 * from -- that pauses exactly those syscalls. A thread here reads the path,
 * and if it names a native root, lazily detaches the mount, then lets the
 * original syscall continue. computerd then serves it through FUSE as it does
 * for any local-only path.
 *
 * This is a convenience, not an enforcement point: a path re-read by the
 * kernel after SECCOMP_USER_NOTIF_FLAG_CONTINUE may differ from the one read
 * here. The worst outcomes are a mount detached for nothing (served through
 * FUSE, remounted on the next mkdir) or a missed detach (EBUSY, as without
 * the guard). A lazy detach is always safe: the mount's source is the same
 * directory computerd serves the path from.
 *
 * The guard thread must never wait on the JavaScript thread, whose own
 * rmdir/rename calls are trapped too. So it reads paths through /proc and
 * process_vm_readv, checks them against an in-memory table, and detaches
 * through a descriptor (/proc/self/fd/N) rather than the path under the FUSE
 * mount, whose walk could need a FUSE lookup answered by that thread.
 */
#define _GNU_SOURCE

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <node_api.h>

#include "removal-guard.h"

#if defined(__linux__) && (defined(__x86_64__) || defined(__aarch64__))
#define GUARD_SUPPORTED 1
#else
#define GUARD_SUPPORTED 0
#endif

static napi_value int32_value(napi_env env, int32_t value) {
  napi_value out = NULL;
  napi_create_int32(env, value, &out);
  return out;
}

#if GUARD_SUPPORTED

#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <unistd.h>

#if defined(__x86_64__)
#define GUARD_ARCH AUDIT_ARCH_X86_64
#else
#define GUARD_ARCH AUDIT_ARCH_AARCH64
#endif

#ifndef SECCOMP_USER_NOTIF_FLAG_CONTINUE
#define SECCOMP_USER_NOTIF_FLAG_CONTINUE (1UL << 0)
#endif

#define GUARD_MAX_INSNS 32
#define GUARD_NOTIF_BUFFER 512
#define GUARD_READ_CHUNK 4096

typedef struct {
  char *path;
  int fd;
} guard_root_t;

static pthread_mutex_t g_roots_lock = PTHREAD_MUTEX_INITIALIZER;
static guard_root_t *g_roots = NULL;
static size_t g_roots_len = 0;
static size_t g_roots_cap = 0;

static atomic_bool g_started = false;
static atomic_ullong g_traps = 0;
static atomic_ullong g_detaches = 0;
static napi_threadsafe_function g_on_detached = NULL;
static int g_handoff[2] = { -1, -1 };

/* Syscalls that name a directory to remove or a path to rename. unlinkat is
 * handled separately: only its AT_REMOVEDIR form is trapped. */
static const int g_notify_nrs[] = {
#ifdef __NR_rmdir
  __NR_rmdir,
#endif
#ifdef __NR_rename
  __NR_rename,
#endif
#ifdef __NR_renameat
  __NR_renameat,
#endif
  __NR_renameat2,
};

static struct sock_filter insn(uint16_t code, uint8_t jt, uint8_t jf, uint32_t k) {
  struct sock_filter out;
  out.code = code;
  out.jt = jt;
  out.jf = jf;
  out.k = k;
  return out;
}

/* Allows everything except the listed syscalls and unlinkat(AT_REMOVEDIR),
 * which go to the listener. Other architectures and x32 are allowed. */
static size_t build_filter(struct sock_filter *f, size_t cap) {
  const uint16_t ld = (uint16_t) (BPF_LD | BPF_W | BPF_ABS);
  const uint16_t jeq = (uint16_t) (BPF_JMP | BPF_JEQ | BPF_K);
  const uint16_t jset = (uint16_t) (BPF_JMP | BPF_JSET | BPF_K);
  const uint16_t ret = (uint16_t) (BPF_RET | BPF_K);
  const size_t listed = sizeof(g_notify_nrs) / sizeof(g_notify_nrs[0]);
#if defined(__x86_64__)
  const size_t x32 = 1;
#else
  const size_t x32 = 0;
#endif
  const size_t total = 3 + x32 + listed + 3 + 2;
  if (total > cap) return 0;
  const size_t allow = total - 2;
  const size_t notify = total - 1;
  size_t i = 0;

#define GUARD_JUMP(target) ((uint8_t) ((target) - i - 1))
  f[i] = insn(ld, 0, 0, (uint32_t) offsetof(struct seccomp_data, arch));
  i++;
  f[i] = insn(jeq, 0, GUARD_JUMP(allow), (uint32_t) GUARD_ARCH);
  i++;
  f[i] = insn(ld, 0, 0, (uint32_t) offsetof(struct seccomp_data, nr));
  i++;
#if defined(__x86_64__)
  f[i] = insn((uint16_t) (BPF_JMP | BPF_JGE | BPF_K), GUARD_JUMP(allow), 0, 0x40000000U);
  i++;
#endif
  for (size_t j = 0; j < listed; j++) {
    f[i] = insn(jeq, GUARD_JUMP(notify), 0, (uint32_t) g_notify_nrs[j]);
    i++;
  }
  f[i] = insn(jeq, 0, GUARD_JUMP(allow), (uint32_t) __NR_unlinkat);
  i++;
  /* The low word of args[2]; both supported architectures are little endian. */
  f[i] = insn(ld, 0, 0, (uint32_t) (offsetof(struct seccomp_data, args) + 2 * sizeof(uint64_t)));
  i++;
  f[i] = insn(jset, GUARD_JUMP(notify), GUARD_JUMP(allow), (uint32_t) AT_REMOVEDIR);
  i++;
  f[i] = insn(ret, 0, 0, SECCOMP_RET_ALLOW);
  i++;
  f[i] = insn(ret, 0, 0, SECCOMP_RET_USER_NOTIF);
  i++;
#undef GUARD_JUMP
  return i;
}

/* Without PR_SET_NO_NEW_PRIVS: computerd has CAP_SYS_ADMIN, and setting it
 * would stop setuid binaries elevating inside commands. Without the
 * capability the kernel refuses, and the guard stays off. */
static int install_listener(void) {
  struct sock_filter f[GUARD_MAX_INSNS];
  size_t n = build_filter(f, GUARD_MAX_INSNS);
  if (n == 0) return -EINVAL;
  struct sock_fprog prog;
  prog.len = (unsigned short) n;
  prog.filter = f;
  long fd = syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &prog);
  return fd < 0 ? -errno : (int) fd;
}

static int read_target_string(pid_t pid, uint64_t addr, char *out, size_t cap) {
  size_t got = 0;
  /* Chunks never cross a 4 KiB boundary, so never a page boundary either,
   * whatever the page size: a string ending just before an unmapped page
   * still reads. */
  while (got + 1 < cap) {
    uint64_t at = addr + got;
    size_t chunk = (size_t) (GUARD_READ_CHUNK - (at % GUARD_READ_CHUNK));
    if (chunk > cap - 1 - got) chunk = cap - 1 - got;
    struct iovec local = { out + got, chunk };
    struct iovec remote = { (void *) (uintptr_t) at, chunk };
    ssize_t n = process_vm_readv(pid, &local, 1, &remote, 1, 0);
    if (n <= 0) return -1;
    if (memchr(out + got, '\0', (size_t) n) != NULL) return 0;
    got += (size_t) n;
  }
  return -1;
}

/* Lexical: "." and ".." are folded, symlinks are not followed. The caller's
 * cwd or dirfd link is already resolved, and a native root is a mount
 * point, so a path through a symlink to one simply does not match. */
static int normalize(const char *in, char *out, size_t cap) {
  size_t len = 0;
  const char *p = in;
  out[0] = '\0';
  while (*p != '\0') {
    while (*p == '/') p++;
    if (*p == '\0') break;
    const char *segment = p;
    while (*p != '\0' && *p != '/') p++;
    size_t segment_len = (size_t) (p - segment);
    if (segment_len == 1 && segment[0] == '.') continue;
    if (segment_len == 2 && segment[0] == '.' && segment[1] == '.') {
      while (len > 0 && out[len - 1] != '/') len--;
      if (len > 0) len--;
      out[len] = '\0';
      continue;
    }
    if (len + 1 + segment_len + 1 > cap) return -1;
    out[len++] = '/';
    memcpy(out + len, segment, segment_len);
    len += segment_len;
    out[len] = '\0';
  }
  if (len == 0) {
    if (cap < 2) return -1;
    out[0] = '/';
    out[1] = '\0';
  }
  return 0;
}

static int resolve(pid_t pid, int dirfd, const char *path, char *out, size_t cap) {
  char joined[PATH_MAX * 2];
  if (path[0] == '/') {
    size_t n = strlen(path);
    if (n >= sizeof(joined)) return -1;
    memcpy(joined, path, n + 1);
  } else {
    char link[64];
    char base[PATH_MAX];
    if (dirfd == AT_FDCWD) {
      snprintf(link, sizeof(link), "/proc/%d/cwd", (int) pid);
    } else {
      snprintf(link, sizeof(link), "/proc/%d/fd/%d", (int) pid, dirfd);
    }
    ssize_t n = readlink(link, base, sizeof(base) - 1);
    if (n <= 0) return -1;
    base[n] = '\0';
    if (base[0] != '/') return -1;
    size_t base_len = (size_t) n;
    size_t path_len = strlen(path);
    if (base_len + 1 + path_len + 1 > sizeof(joined)) return -1;
    memcpy(joined, base, base_len);
    joined[base_len] = '/';
    memcpy(joined + base_len + 1, path, path_len + 1);
  }
  return normalize(joined, out, cap);
}

static void call_js(napi_env env, napi_value js_cb, void *context, void *data) {
  (void) context;
  char *path = (char *) data;
  if (env != NULL && js_cb != NULL && path != NULL) {
    napi_value undefined = NULL;
    napi_value arg = NULL;
    if (napi_get_undefined(env, &undefined) == napi_ok &&
        napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &arg) == napi_ok) {
      napi_call_function(env, undefined, js_cb, 1, &arg, NULL);
    }
  }
  free(path);
}

static void detach_if_root(const char *path) {
  int fd = -1;
  char *owned = NULL;
  pthread_mutex_lock(&g_roots_lock);
  for (size_t i = 0; i < g_roots_len; i++) {
    if (strcmp(g_roots[i].path, path) == 0) {
      fd = g_roots[i].fd;
      owned = g_roots[i].path;
      g_roots[i] = g_roots[--g_roots_len];
      break;
    }
  }
  pthread_mutex_unlock(&g_roots_lock);
  if (fd < 0) return;

  char link[64];
  snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
  /* EINVAL means it was already detached, by computerd or the kernel. */
  if (umount2(link, MNT_DETACH) == 0) atomic_fetch_add(&g_detaches, 1);
  close(fd);
  /* Tell computerd so it parks the root: a lookup must not remount it
   * under the removal that is about to continue. */
  if (g_on_detached != NULL &&
      napi_call_threadsafe_function(g_on_detached, owned, napi_tsfn_nonblocking) == napi_ok) {
    owned = NULL;
  }
  free(owned);
}

static void handle(int listener, const struct seccomp_notif *req) {
  const struct seccomp_data *d = &req->data;
  int dirs[2] = { AT_FDCWD, AT_FDCWD };
  uint64_t paths[2] = { 0, 0 };
  int count = 0;

  if (d->nr == __NR_unlinkat) {
    dirs[0] = (int) (int32_t) (uint32_t) d->args[0];
    paths[0] = d->args[1];
    count = 1;
#ifdef __NR_rmdir
  } else if (d->nr == __NR_rmdir) {
    paths[0] = d->args[0];
    count = 1;
#endif
#ifdef __NR_rename
  } else if (d->nr == __NR_rename) {
    paths[0] = d->args[0];
    paths[1] = d->args[1];
    count = 2;
#endif
#ifdef __NR_renameat
  } else if (d->nr == __NR_renameat) {
    dirs[0] = (int) (int32_t) (uint32_t) d->args[0];
    paths[0] = d->args[1];
    dirs[1] = (int) (int32_t) (uint32_t) d->args[2];
    paths[1] = d->args[3];
    count = 2;
#endif
  } else if (d->nr == __NR_renameat2) {
    dirs[0] = (int) (int32_t) (uint32_t) d->args[0];
    paths[0] = d->args[1];
    dirs[1] = (int) (int32_t) (uint32_t) d->args[2];
    paths[1] = d->args[3];
    count = 2;
  }

  for (int i = 0; i < count; i++) {
    char raw[PATH_MAX];
    char absolute[PATH_MAX];
    if (read_target_string((pid_t) req->pid, paths[i], raw, sizeof(raw)) != 0) continue;
    if (resolve((pid_t) req->pid, dirs[i], raw, absolute, sizeof(absolute)) != 0) continue;
    /* The task may have died, or the call been interrupted, since. */
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &req->id) != 0) return;
    detach_if_root(absolute);
  }
}

static void *guard_main(void *unused) {
  (void) unused;
  int listener = -1;
  ssize_t got;
  do {
    got = read(g_handoff[0], &listener, sizeof(listener));
  } while (got < 0 && errno == EINTR);
  close(g_handoff[0]);
  if (got != (ssize_t) sizeof(listener) || listener < 0) return NULL;

  static union {
    struct seccomp_notif notif;
    unsigned char bytes[GUARD_NOTIF_BUFFER];
  } req_buf;
  static union {
    struct seccomp_notif_resp resp;
    unsigned char bytes[GUARD_NOTIF_BUFFER];
  } resp_buf;
  size_t req_size = sizeof(req_buf.notif);
  size_t resp_size = sizeof(resp_buf.resp);
  struct seccomp_notif_sizes sizes;
  if (syscall(SYS_seccomp, SECCOMP_GET_NOTIF_SIZES, 0, &sizes) == 0) {
    if (sizes.seccomp_notif > req_size) req_size = sizes.seccomp_notif;
    if (sizes.seccomp_notif_resp > resp_size) resp_size = sizes.seccomp_notif_resp;
  }
  if (req_size > GUARD_NOTIF_BUFFER || resp_size > GUARD_NOTIF_BUFFER) {
    /* Closing the listener makes trapped calls fail with ENOSYS rather
     * than wait forever. Not expected on any current kernel. */
    close(listener);
    return NULL;
  }

  for (;;) {
    memset(&req_buf, 0, req_size);
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &req_buf.notif) != 0) {
      if (errno == EINTR || errno == ENOENT) continue;
      close(listener);
      return NULL;
    }
    atomic_fetch_add(&g_traps, 1);
    handle(listener, &req_buf.notif);
    memset(&resp_buf, 0, resp_size);
    resp_buf.resp.id = req_buf.notif.id;
    resp_buf.resp.flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
    /* ENOENT: the task went away; nothing to answer. */
    ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, &resp_buf.resp);
  }
  return NULL;
}

static int start_guard(void) {
  if (pipe2(g_handoff, O_CLOEXEC) != 0) return -errno;
  pthread_t thread;
  int err = pthread_create(&thread, NULL, guard_main, NULL);
  if (err != 0) {
    close(g_handoff[0]);
    close(g_handoff[1]);
    return -err;
  }
  pthread_detach(thread);
  /* The thread exists before the filter, so it does not inherit it and can
   * never be the one waiting on itself. */
  int listener = install_listener();
  ssize_t written;
  do {
    written = write(g_handoff[1], &listener, sizeof(listener));
  } while (written < 0 && errno == EINTR);
  close(g_handoff[1]);
  return listener < 0 ? listener : 0;
}

static bool get_string(napi_env env, napi_value value, char *out, size_t cap) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, out, cap, &len) != napi_ok) return false;
  return len > 0 && len + 1 < cap;
}

/* guardStart(onDetached): installs the filter on the calling thread and starts
 * the guard. Returns 0 or -errno; -EALREADY when already started. */
napi_value fuse_native_guard_start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = { NULL };
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (atomic_exchange(&g_started, true)) return int32_value(env, -EALREADY);

  napi_valuetype type = napi_undefined;
  if (argc >= 1 && napi_typeof(env, argv[0], &type) == napi_ok && type == napi_function) {
    napi_value name = NULL;
    napi_create_string_utf8(env, "computerd-removal-guard", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, argv[0], NULL, name, 0, 1, NULL, NULL, NULL, call_js,
                                        &g_on_detached) == napi_ok) {
      napi_unref_threadsafe_function(env, g_on_detached);
    } else {
      g_on_detached = NULL;
    }
  }

  int result = start_guard();
  if (result != 0) {
    if (g_on_detached != NULL) {
      napi_release_threadsafe_function(g_on_detached, napi_tsfn_abort);
      g_on_detached = NULL;
    }
    atomic_store(&g_started, false);
  }
  return int32_value(env, result);
}

/* guardAddRoot(path, fd): the guard takes ownership of fd, an open directory
 * at the root of the mount. Replaces any earlier entry for path. */
napi_value fuse_native_guard_add_root(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = { NULL, NULL };
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char path[PATH_MAX];
  int32_t fd = -1;
  if (argc < 2 || napi_get_value_int32(env, argv[1], &fd) != napi_ok || fd < 0) {
    return int32_value(env, -EINVAL);
  }
  /* From here on the descriptor is ours, whatever happens. */
  if (!get_string(env, argv[0], path, sizeof(path))) {
    close(fd);
    return int32_value(env, -EINVAL);
  }
  char *copy = strdup(path);
  if (copy == NULL) {
    close(fd);
    return int32_value(env, -ENOMEM);
  }

  int old_fd = -1;
  char *old_path = NULL;
  int result = 0;
  pthread_mutex_lock(&g_roots_lock);
  size_t i = 0;
  for (; i < g_roots_len; i++) {
    if (strcmp(g_roots[i].path, path) == 0) break;
  }
  if (i < g_roots_len) {
    old_fd = g_roots[i].fd;
    old_path = g_roots[i].path;
    g_roots[i].path = copy;
    g_roots[i].fd = fd;
  } else if (g_roots_len == g_roots_cap) {
    size_t cap = g_roots_cap == 0 ? 16 : g_roots_cap * 2;
    guard_root_t *grown = realloc(g_roots, cap * sizeof(guard_root_t));
    if (grown == NULL) {
      result = -ENOMEM;
    } else {
      g_roots = grown;
      g_roots_cap = cap;
    }
  }
  if (result == 0 && i == g_roots_len) {
    g_roots[g_roots_len].path = copy;
    g_roots[g_roots_len].fd = fd;
    g_roots_len++;
  }
  pthread_mutex_unlock(&g_roots_lock);

  if (result != 0) {
    free(copy);
    close(fd);
  }
  if (old_fd >= 0) close(old_fd);
  free(old_path);
  return int32_value(env, result);
}

/* guardRemoveRoot(path): forgets path and closes its descriptor. Returns 1
 * if it was known, else 0. */
napi_value fuse_native_guard_remove_root(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = { NULL };
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char path[PATH_MAX];
  if (argc < 1 || !get_string(env, argv[0], path, sizeof(path))) return int32_value(env, 0);
  int fd = -1;
  char *owned = NULL;
  pthread_mutex_lock(&g_roots_lock);
  for (size_t i = 0; i < g_roots_len; i++) {
    if (strcmp(g_roots[i].path, path) == 0) {
      fd = g_roots[i].fd;
      owned = g_roots[i].path;
      g_roots[i] = g_roots[--g_roots_len];
      break;
    }
  }
  pthread_mutex_unlock(&g_roots_lock);
  if (fd >= 0) close(fd);
  free(owned);
  return int32_value(env, fd >= 0 ? 1 : 0);
}

/* guardStats(): { traps, detaches, roots }. */
napi_value fuse_native_guard_stats(napi_env env, napi_callback_info info) {
  (void) info;
  napi_value out = NULL;
  napi_value value = NULL;
  napi_create_object(env, &out);
  napi_create_double(env, (double) atomic_load(&g_traps), &value);
  napi_set_named_property(env, out, "traps", value);
  napi_create_double(env, (double) atomic_load(&g_detaches), &value);
  napi_set_named_property(env, out, "detaches", value);
  pthread_mutex_lock(&g_roots_lock);
  double roots = (double) g_roots_len;
  pthread_mutex_unlock(&g_roots_lock);
  napi_create_double(env, roots, &value);
  napi_set_named_property(env, out, "roots", value);
  return out;
}

#else /* !GUARD_SUPPORTED */

napi_value fuse_native_guard_start(napi_env env, napi_callback_info info) {
  (void) info;
  return int32_value(env, -ENOSYS);
}

napi_value fuse_native_guard_add_root(napi_env env, napi_callback_info info) {
  (void) info;
  return int32_value(env, -ENOSYS);
}

napi_value fuse_native_guard_remove_root(napi_env env, napi_callback_info info) {
  (void) info;
  return int32_value(env, 0);
}

napi_value fuse_native_guard_stats(napi_env env, napi_callback_info info) {
  (void) info;
  napi_value out = NULL;
  napi_create_object(env, &out);
  return out;
}

#endif
