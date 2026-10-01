#define FUSE_USE_VERSION 31

/*
 * macFUSE's libfuse 3 ABI has Darwin-specific operation signatures for
 * metadata and resource-fork support.  Keep those extensions enabled on
 * macOS and bridge them to the portable JavaScript contract with explicit
 * adapters below.
 */
#ifdef __APPLE__
#define FUSE_DARWIN_ENABLE_EXTENSIONS 1
#endif

#include <uv.h>
#include <node_api.h>
#include <napi-macros.h>

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>

#if defined(__APPLE__) && defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdollar-in-identifier-extension"
#endif
#if defined(__GNUC__)
#pragma GCC diagnostic push
/*
 * Some supported libfuse headers contain file-scope static-assert macros with
 * a trailing semicolon. Keep pedantic diagnostics strict for this addon while
 * treating that external header implementation as a system boundary.
 */
#pragma GCC diagnostic ignored "-Wpedantic"
#endif
#include <fuse.h>
#include <fuse_opt.h>
#include <fuse_common.h>
#include <fuse_lowlevel.h>

#ifdef __linux__
#include <sys/ioctl.h>
#include <linux/fuse.h>

/* Older build hosts may predate the passthrough ioctls. */
#ifndef FUSE_DEV_IOC_BACKING_OPEN
#ifndef FUSE_DEV_IOC_MAGIC
#define FUSE_DEV_IOC_MAGIC 229
#endif
struct fuse_backing_map {
  int32_t fd;
  uint32_t flags;
  uint64_t padding[3];
};
#define FUSE_DEV_IOC_BACKING_OPEN \
  _IOW(FUSE_DEV_IOC_MAGIC, 1, struct fuse_backing_map)
#define FUSE_DEV_IOC_BACKING_CLOSE _IOW(FUSE_DEV_IOC_MAGIC, 2, uint32_t)
#endif
#endif
#include <fuse_lowlevel.h>
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
#if defined(__APPLE__) && defined(__clang__)
#pragma clang diagnostic pop
#endif

#include <unistd.h>
#include <sys/wait.h>
#include <sys/ioctl.h>
#include <fcntl.h>
#include <pthread.h>
#ifdef __linux__
#include <sys/sysmacros.h>
#include <linux/ioctl.h>
#include <linux/stat.h>
#endif

#ifdef __APPLE__
#include <dlfcn.h>
/*
 * macFUSE can return transport-owned message buffers from the public custom
 * event-loop API, but currently omits the corresponding release function from
 * its headers. Resolve the helper at runtime so a changed backend ABI becomes
 * a controlled mount failure rather than a load-time linker failure.
 */
typedef void (*fuse_native_buf_free_fn)(struct fuse_buf *buf);
#endif

typedef struct fuse_thread_s fuse_thread_t;
typedef struct fuse_thread_locals_s fuse_thread_locals_t;
typedef struct fuse_worker_s fuse_worker_t;
typedef struct fuse_poll_registration_s fuse_poll_registration_t;
typedef struct fuse_invalidation_request_s fuse_invalidation_request_t;
#if defined(__APPLE__) && FUSE_DARWIN_ENABLE_EXTENSIONS
typedef fuse_darwin_fill_dir_t fuse_native_fill_dir_t;
#else
typedef fuse_fill_dir_t fuse_native_fill_dir_t;
#endif
typedef void (*fuse_dispatch_fn)(uv_async_t *, fuse_thread_locals_t *, fuse_thread_t *);
static void fuse_native_complete_local(fuse_thread_locals_t *l, int32_t result);
static void fuse_native_release_local_payload(fuse_thread_locals_t *l);
static void fuse_native_capture_context(fuse_thread_locals_t *l);
static int fuse_native_schedule_local(fuse_thread_locals_t *l);
static void fuse_native_close_poll_registration(fuse_poll_registration_t *registration);
static void fuse_native_release_poll_registration(fuse_poll_registration_t *registration);
static void fuse_native_dispose_mount(
  struct fuse *fuse,
  int mounted
);
static napi_status create_request_context_value(
  napi_env env,
  const fuse_thread_locals_t *l,
  napi_value *result
);
static napi_status initialize_callback_arguments(
  napi_env env,
  napi_value *argv,
  size_t argc
);

#define FUSE_NATIVE_CALLBACK(fn, blk)\
  napi_env env = ft->env;\
  napi_handle_scope scope;\
  if (napi_open_handle_scope(env, &scope) != napi_ok) {\
    fuse_native_complete_local(l, -EIO);\
    return;\
  }\
  napi_value ctx;\
  napi_value callback;\
  if (napi_get_reference_value(env, ft->ctx, &ctx) != napi_ok ||\
      napi_get_reference_value(env, fn, &callback) != napi_ok) {\
    napi_close_handle_scope(env, scope);\
    fuse_native_complete_local(l, -EIO);\
    return;\
  }\
  blk\
  napi_close_handle_scope(env, scope);

#define FUSE_NATIVE_HANDLER(name, blk)\
  fuse_thread_locals_t *l = get_thread_locals();\
  if (l == NULL) return -EIO;\
  l->info = NULL;\
  l->info_out = NULL;\
  l->owned_input = NULL;\
  l->pollhandle = NULL;\
  l->poll_registration = NULL;\
  l->signed_result = 0;\
  l->op = op_##name;\
  l->op_fn = fuse_native_dispatch_##name;\
  blk\
  fuse_native_capture_context(l);\
  atomic_store(&(l->waiting), 1);\
  if (fuse_native_schedule_local(l) < 0) {\
    atomic_store(&(l->waiting), 0);\
    fuse_native_release_local_payload(l);\
    return -EIO;\
  }\
  uv_sem_wait(&(l->sem));\
  return l->res;

#define FUSE_CALL_CALLBACK(argc, argv)\
  napi_status callback_status = napi_make_callback(env, NULL, ctx, callback, argc, argv, NULL);\
  if (callback_status != napi_ok) {\
    napi_value callback_exception = NULL;\
    if (callback_status == napi_pending_exception) {\
      napi_get_and_clear_last_exception(env, &callback_exception);\
    }\
    napi_close_handle_scope(env, scope);\
    fuse_native_complete_local(l, -EIO);\
    if (callback_exception != NULL) napi_fatal_exception(env, callback_exception);\
    return;\
  }

#define FUSE_METHOD(name, callbackArgs, signalArgs, signature, callBlk, callbackBlk, signalBlk)\
  static void fuse_native_dispatch_##name (uv_async_t* handle, fuse_thread_locals_t* l, fuse_thread_t* ft) {\
    (void) handle;\
    uint32_t op = op_##name;\
    FUSE_NATIVE_CALLBACK(ft->handlers[op], {\
      napi_value argv[callbackArgs + 3] = {0};\
      if (initialize_callback_arguments(env, argv, callbackArgs + 3) != napi_ok ||\
          napi_get_reference_value(env, l->self, &(argv[0])) != napi_ok ||\
          napi_create_uint32(env, l->op, &(argv[1])) != napi_ok) {\
        napi_close_handle_scope(env, scope);\
        fuse_native_complete_local(l, -EIO);\
        return;\
      }\
      callbackBlk\
      if (create_request_context_value(env, l, &(argv[callbackArgs + 2])) != napi_ok) {\
        napi_close_handle_scope(env, scope);\
        fuse_native_complete_local(l, -EIO);\
        return;\
      }\
      FUSE_CALL_CALLBACK(callbackArgs + 3, argv)\
    })\
  }\
  NAPI_METHOD(fuse_native_signal_##name) {\
    NAPI_ARGV(signalArgs + 2)\
    NAPI_ARGV_BUFFER_CAST(fuse_thread_locals_t *, l, 0);\
    NAPI_ARGV_INT32(res, 1);\
    signalBlk\
    fuse_native_complete_local(l, res);\
    return NULL;\
  }\
  static int fuse_native_##name signature {\
    FUSE_NATIVE_HANDLER(name, callBlk)\
  }

#define FUSE_METHOD_VOID(name, callbackArgs, signalArgs, signature, callBlk, callbackBlk)\
  FUSE_METHOD(name, callbackArgs, signalArgs, signature, callBlk, callbackBlk, {})

#define FUSE_UINT64_TO_INTS_ARGV(n, pos)\
  uint64_t bits##pos = (uint64_t) (n);\
  uint32_t low##pos = (uint32_t) (bits##pos & UINT32_MAX);\
  uint32_t high##pos = (uint32_t) (bits##pos >> 32);\
  napi_create_uint32(env, low##pos, &(argv[pos]));\
  napi_create_uint32(env, high##pos, &(argv[pos + 1]));

#define FUSE_CREATE_UINT64_ARGV(n, pos)\
  if (create_uint64_value(env, (uint64_t) (n), &(argv[pos])) != napi_ok) {\
    fuse_native_complete_local(l, -EIO);\
    napi_close_handle_scope(env, scope);\
    return;\
  }

#define FUSE_CREATE_OWNED_BUFFER_ARGV(source, length, pos)\
  if (create_owned_buffer(env, source, length, &(argv[pos])) != napi_ok) {\
    fuse_native_complete_local(l, -EIO);\
    napi_close_handle_scope(env, scope);\
    return;\
  }

#define FUSE_CREATE_PATH_ARGV(path, pos)\
  napi_status path_status##pos = (path) == NULL\
    ? napi_get_null(env, &(argv[pos]))\
    : napi_create_string_utf8(env, (path), NAPI_AUTO_LENGTH, &(argv[pos]));\
  if (path_status##pos != napi_ok) {\
    fuse_native_complete_local(l, -EIO);\
    napi_close_handle_scope(env, scope);\
    return;\
  }

#define FUSE_CREATE_FILE_HANDLE_ARGV(pos)\
  FUSE_CREATE_UINT64_ARGV(l->info == NULL ? 0 : l->info->fh, pos)


// Opcodes

static const uint32_t op_init = 0;
static const uint32_t op_error = 1;
static const uint32_t op_access = 2;
static const uint32_t op_statfs = 3;
static const uint32_t op_fgetattr = 4;
static const uint32_t op_getattr = 5;
static const uint32_t op_flush = 6;
static const uint32_t op_fsync = 7;
static const uint32_t op_fsyncdir = 8;
static const uint32_t op_readdir = 9;
static const uint32_t op_truncate = 10;
static const uint32_t op_ftruncate = 11;
static const uint32_t op_utimens = 12;
static const uint32_t op_readlink = 13;
static const uint32_t op_chown = 14;
static const uint32_t op_chmod = 15;
static const uint32_t op_mknod = 16;
static const uint32_t op_setxattr = 17;
static const uint32_t op_getxattr = 18;
static const uint32_t op_listxattr = 19;
static const uint32_t op_removexattr = 20;
static const uint32_t op_open = 21;
static const uint32_t op_opendir = 22;
static const uint32_t op_read = 23;
static const uint32_t op_write = 24;
static const uint32_t op_release = 25;
static const uint32_t op_releasedir = 26;
static const uint32_t op_create = 27;
static const uint32_t op_unlink = 28;
static const uint32_t op_rename = 29;
static const uint32_t op_link = 30;
static const uint32_t op_symlink = 31;
static const uint32_t op_mkdir = 32;
static const uint32_t op_rmdir = 33;
static const uint32_t op_destroy = 34;
static const uint32_t op_lock = 35;
static const uint32_t op_bmap = 36;
static const uint32_t op_ioctl = 37;
static const uint32_t op_poll = 38;
static const uint32_t op_write_buf = 39;
static const uint32_t op_read_buf = 40;
static const uint32_t op_flock = 41;
static const uint32_t op_fallocate = 42;
static const uint32_t op_copy_file_range = 43;
static const uint32_t op_lseek = 44;
#define FUSE_OPERATION_COUNT 45
#define FUSE_MAX_WORKERS 64
#define FUSE_MAX_PENDING_INVALIDATIONS 1024
#define FUSE_OPERATION_FLAG_NULL_PATH_OK 1U
#define FUSE_OPERATION_FLAG_NO_PATH 2U
#define FUSE_OPERATION_FLAG_UTIME_OMIT_OK 4U
#define FUSE_OPERATION_FLAG_DIRECT_IO 8U
#define FUSE_OPERATION_FLAG_POLL_HANDLE 16U
#define FUSE_OPERATION_FLAGS_ALLOWED \
  (FUSE_OPERATION_FLAG_NULL_PATH_OK | FUSE_OPERATION_FLAG_NO_PATH | \
   FUSE_OPERATION_FLAG_UTIME_OMIT_OK | FUSE_OPERATION_FLAG_DIRECT_IO | \
   FUSE_OPERATION_FLAG_POLL_HANDLE)

// Data structures

struct fuse_thread_s {
  napi_env env;
  uv_loop_t *loop;
  pthread_t thread;
  pthread_attr_t attr;
  napi_ref ctx;
  napi_ref state_ref;
  napi_ref cleanup_cb;
  napi_ref loop_exit_cb;
  napi_ref mount_cb;

  // Operation handlers
  napi_ref handlers[FUSE_OPERATION_COUNT];
  uint8_t implemented[FUSE_OPERATION_COUNT];

  struct fuse *fuse;
  struct fuse_operations ops;
  char *mnt;
  char *mntopts;
  int mounted;
  int fuse_mounted;
  uint32_t operation_flags;
  bool max_read_configured;
  uint32_t configured_max_read;
  int mount_pending;
  int mount_cleanup_pending;
  int mount_error;
  int thread_started;
  int attr_initialized;
  int mutex_initialized;
  int workers_sem_initialized;
  int loop_exit_async_initialized;
  int invalidation_mutex_initialized;
  int invalidation_cond_initialized;
  int invalidation_thread_started;
  int invalidation_active;
  int invalidation_stopping;
  atomic_int cleanup_scheduled;
  atomic_int cleanup_requested;
  atomic_int mount_cancelled;
  int env_cleanup;
  int cleanup_error;
  int cleanup_thread_joined;
  int cleanup_invalidation_thread_joined;
  int fuse_cache_cleanup_started;
  atomic_int loop_result;
  size_t max_workers;
  size_t workers_started;
  size_t close_pending;
  fuse_thread_locals_t *locals;
  fuse_worker_t *workers;
  fuse_poll_registration_t *polls;
  fuse_invalidation_request_t *invalidation_head;
  fuse_invalidation_request_t *invalidation_tail;
  size_t invalidation_pending;
  uint64_t next_poll_id;
  napi_async_cleanup_hook_handle cleanup_hook;
#ifdef __APPLE__
  fuse_native_buf_free_fn buf_free;
#endif

  uv_async_t loop_exit_async;
  uv_mutex_t mut;
  uv_mutex_t invalidation_mut;
  uv_cond_t invalidation_cond;
  pthread_t invalidation_thread;
  uv_sem_t workers_finished;
  uv_work_t cleanup_work;
  uv_work_t mount_work;
};

struct fuse_invalidation_request_s {
  napi_threadsafe_function callback;
  fuse_invalidation_request_t *next;
  char *name;
  uint64_t parent;
  size_t name_length;
  int32_t result;
};

struct fuse_worker_s {
  fuse_thread_t *fuse;
  fuse_thread_locals_t *locals;
  pthread_t thread;
  struct fuse_buf buffer;
};

struct fuse_poll_registration_s {
  /* Immutable while either the registry or an in-flight request owns it. */
  fuse_thread_t *fuse;
  struct fuse_pollhandle *handle;
  uint64_t id;
  fuse_poll_registration_t *next;
  atomic_uint references;
};

struct fuse_thread_locals_s {
  napi_ref self;

  // Opcode
  uint32_t op;
  fuse_dispatch_fn op_fn;

  // Payloads
  const char *path;
  const char *dest;
  char *linkname;
  struct fuse_file_info *info;
  struct fuse_file_info *info_out;
  struct fuse_conn_info *conn;
  struct fuse_config *config;
  const void *buf;
  void *owned_input;
  off_t offset;
  off_t length;
  size_t len;
  mode_t mode;
  int int_value;
  dev_t dev;
  uid_t uid;
  gid_t gid;
  struct timespec atime;
  struct timespec mtime;
  int32_t res;
  int64_t signed_result;
  uint32_t request_uid;
  uint32_t request_gid;
  uint32_t request_pid;
  uint32_t request_umask;

  // Extended attributes
  const char *name;
  const char *value;
  char *list;
  size_t size;
  uint32_t position;
  int flags;
  int cmd;
  struct flock *lock;
  uint64_t *bmap_index;
  void *ioctl_data;
  uintptr_t ioctl_argument;
  struct fuse_pollhandle *pollhandle;
  fuse_poll_registration_t *poll_registration;
  unsigned *poll_revents;
  struct fuse_bufvec **bufvec_out;

  // Stat + Statfs
  struct stat *stat;
  struct statvfs *statvfs;

  // Readdir
  fuse_native_fill_dir_t readdir_filler;

  // Internal bookkeeping
  fuse_thread_t *fuse;
  uv_sem_t sem;
  uv_async_t async;
  int sem_initialized;
  int async_initialized;
  atomic_int waiting;
  fuse_thread_locals_t *next;

};

static void fuse_native_complete_local (fuse_thread_locals_t *l, int32_t result) {
  if (atomic_exchange(&(l->waiting), 0) == 1) {
    fuse_native_release_local_payload(l);
    l->res = result;
    uv_sem_post(&(l->sem));
  }
}

static void fuse_native_invalidation_finalize (
  napi_env env,
  void *finalize_data,
  void *finalize_hint
) {
  (void) env;
  (void) finalize_hint;
  fuse_invalidation_request_t *request = (fuse_invalidation_request_t *) finalize_data;
  free(request->name);
  free(request);
}

static void fuse_native_invalidation_dispatch (
  napi_env env,
  napi_value callback,
  void *context,
  void *data
) {
  (void) context;
  if (env == NULL || callback == NULL || data == NULL) return;

  fuse_invalidation_request_t *request = (fuse_invalidation_request_t *) data;
  napi_value global;
  napi_value result;
  if (napi_get_global(env, &global) != napi_ok ||
      napi_create_int32(env, request->result, &result) != napi_ok) {
    return;
  }

  napi_status status = napi_call_function(env, global, callback, 1, &result, NULL);
  if (status == napi_pending_exception) {
    napi_value exception;
    if (napi_get_and_clear_last_exception(env, &exception) == napi_ok) {
      napi_fatal_exception(env, exception);
    }
  }
}

static void fuse_native_complete_invalidation (
  fuse_invalidation_request_t *request,
  int32_t result
) {
  request->result = result;
  napi_status status = napi_call_threadsafe_function(
    request->callback,
    request,
    napi_tsfn_nonblocking
  );
  napi_release_threadsafe_function(
    request->callback,
    status == napi_ok ? napi_tsfn_release : napi_tsfn_abort
  );
}

static void* fuse_native_invalidation_worker (void *data) {
  fuse_thread_t *ft = (fuse_thread_t *) data;

  while (true) {
    uv_mutex_lock(&(ft->invalidation_mut));
    while (ft->invalidation_head == NULL &&
           !atomic_load(&(ft->cleanup_requested))) {
      uv_cond_wait(&(ft->invalidation_cond), &(ft->invalidation_mut));
    }

    if (ft->invalidation_head == NULL &&
        atomic_load(&(ft->cleanup_requested))) {
      uv_mutex_unlock(&(ft->invalidation_mut));
      break;
    }

    fuse_invalidation_request_t *request = ft->invalidation_head;
    ft->invalidation_head = request->next;
    if (ft->invalidation_head == NULL) ft->invalidation_tail = NULL;
    request->next = NULL;
    if (ft->invalidation_pending > 0) ft->invalidation_pending--;
    uv_mutex_unlock(&(ft->invalidation_mut));

    int32_t result = -ENOTCONN;
    struct fuse_session *session = NULL;
    uv_mutex_lock(&(ft->invalidation_mut));
    if (!atomic_load(&(ft->cleanup_requested)) &&
        !ft->invalidation_stopping &&
        ft->mounted &&
        ft->fuse != NULL) {
      session = fuse_get_session(ft->fuse);
      ft->invalidation_active = session != NULL;
    }
    uv_mutex_unlock(&(ft->invalidation_mut));

    if (session != NULL) {
      result = fuse_lowlevel_notify_inval_entry(
        session,
        (fuse_ino_t) request->parent,
        request->name,
        request->name_length
      );
      uv_mutex_lock(&(ft->invalidation_mut));
      ft->invalidation_active = 0;
      uv_cond_broadcast(&(ft->invalidation_cond));
      uv_mutex_unlock(&(ft->invalidation_mut));
    }
    fuse_native_complete_invalidation(request, result);
  }

  return NULL;
}

static void fuse_native_release_local_payload (fuse_thread_locals_t *l) {
  free(l->owned_input);
  l->owned_input = NULL;
  if (l->pollhandle != NULL) {
    fuse_pollhandle_destroy(l->pollhandle);
    l->pollhandle = NULL;
  }
  if (l->poll_registration != NULL) {
    fuse_native_close_poll_registration(l->poll_registration);
    l->poll_registration = NULL;
  }
}

static fuse_poll_registration_t *fuse_native_register_poll (
  fuse_thread_t *ft,
  struct fuse_pollhandle *handle
) {
  if (handle == NULL || !ft->mutex_initialized) return NULL;
  fuse_poll_registration_t *registration = calloc(1, sizeof(*registration));
  if (registration == NULL) return NULL;

  uv_mutex_lock(&(ft->mut));
  if (atomic_load(&(ft->cleanup_requested))) {
    uv_mutex_unlock(&(ft->mut));
    free(registration);
    return NULL;
  }
  ft->next_poll_id++;
  if (ft->next_poll_id == 0) ft->next_poll_id++;
  registration->fuse = ft;
  registration->handle = handle;
  registration->id = ft->next_poll_id;
  registration->next = ft->polls;
  /*
   * The registry and the in-flight request each own one reference. JavaScript
   * may close a PollHandle before its original callback completes, while
   * teardown may concurrently close the entire registry.
   */
  atomic_init(&(registration->references), 2);
  ft->polls = registration;
  uv_mutex_unlock(&(ft->mut));
  return registration;
}

static void fuse_native_release_poll_registration (
  fuse_poll_registration_t *registration
) {
  if (registration != NULL &&
      atomic_fetch_sub(&(registration->references), 1) == 1) {
    free(registration);
  }
}

static void fuse_native_close_poll_registration (
  fuse_poll_registration_t *registration
) {
  if (registration == NULL) return;
  fuse_thread_t *ft = registration->fuse;
  struct fuse_pollhandle *handle = NULL;
  bool removed = false;
  if (ft != NULL && ft->mutex_initialized) {
    uv_mutex_lock(&(ft->mut));
    fuse_poll_registration_t **cursor = &(ft->polls);
    while (*cursor != NULL && *cursor != registration) {
      cursor = &((*cursor)->next);
    }
    if (*cursor == registration) {
      *cursor = registration->next;
      handle = registration->handle;
      registration->handle = NULL;
      removed = true;
    }
    uv_mutex_unlock(&(ft->mut));
  }
  if (handle != NULL) fuse_pollhandle_destroy(handle);
  if (removed) fuse_native_release_poll_registration(registration);
  fuse_native_release_poll_registration(registration);
}

static void fuse_native_close_all_polls (fuse_thread_t *ft) {
  if (!ft->mutex_initialized) return;
  uv_mutex_lock(&(ft->mut));
  fuse_poll_registration_t *registration = ft->polls;
  ft->polls = NULL;
  while (registration != NULL) {
    fuse_poll_registration_t *next = registration->next;
    if (registration->handle != NULL) {
      fuse_pollhandle_destroy(registration->handle);
      registration->handle = NULL;
    }
    fuse_native_release_poll_registration(registration);
    registration = next;
  }
  uv_mutex_unlock(&(ft->mut));
}

static pthread_key_t thread_locals_key;
static pthread_once_t thread_locals_once = PTHREAD_ONCE_INIT;
static int thread_locals_status = 0;
static fuse_thread_locals_t* get_thread_locals(void);

static void create_thread_locals_key (void) {
  thread_locals_status = pthread_key_create(&(thread_locals_key), NULL);
}

static void fuse_native_capture_context (fuse_thread_locals_t *l) {
  struct fuse_context *ctx = fuse_get_context();
  if (ctx == NULL) {
    l->request_uid = 0;
    l->request_gid = 0;
    l->request_pid = 0;
    l->request_umask = 0;
    return;
  }
  l->request_uid = (uint32_t) ctx->uid;
  l->request_gid = (uint32_t) ctx->gid;
  l->request_pid = (uint32_t) ctx->pid;
  l->request_umask = (uint32_t) ctx->umask;
}

static napi_status create_request_context_value (
  napi_env env,
  const fuse_thread_locals_t *l,
  napi_value *result
) {
  napi_value arraybuffer;
  void *raw_data = NULL;
  napi_status status = napi_create_arraybuffer(
    env,
    11 * sizeof(uint32_t),
    &raw_data,
    &arraybuffer
  );
  if (status != napi_ok) return status;
  uint32_t *data = (uint32_t *) raw_data;
  data[0] = l->request_uid;
  data[1] = l->request_gid;
  data[2] = l->request_pid;
  data[3] = l->request_umask;
  data[4] = l->info == NULL ? 0U : 1U;
  data[5] = l->info == NULL ? 0U : (uint32_t) l->info->flags;
  data[6] = 0U;
  data[7] = 0U;
  data[8] = 0U;
  data[9] = 0U;
  data[10] = 0U;
  if (l->info != NULL) {
    if (l->info->writepage) data[6] |= 1U;
    if (l->info->direct_io) data[6] |= 2U;
    if (l->info->keep_cache) data[6] |= 4U;
    if (l->info->flush) data[6] |= 8U;
    if (l->info->nonseekable) data[6] |= 16U;
    if (l->info->flock_release) data[6] |= 32U;
    data[7] = (uint32_t) (l->info->fh & UINT32_MAX);
    data[8] = (uint32_t) (l->info->fh >> 32);
    data[9] = (uint32_t) (l->info->lock_owner & UINT32_MAX);
    data[10] = (uint32_t) (l->info->lock_owner >> 32);
  }
  return napi_create_typedarray(
    env,
    napi_uint32_array,
    11,
    arraybuffer,
    0,
    result
  );
}

static napi_status initialize_callback_arguments (
  napi_env env,
  napi_value *argv,
  size_t argc
) {
  for (size_t i = 0; i < argc; i++) {
    napi_status status = napi_get_undefined(env, &(argv[i]));
    if (status != napi_ok) return status;
  }
  return napi_ok;
}

// Helpers
// TODO: Extract into a separate file.

static uint64_t uint32s_to_uint64 (uint32_t **ints) {
  uint64_t low = *((*ints)++);
  uint64_t high = *((*ints)++);
  return (high << 32) | low;
}

static int64_t uint32s_to_int64 (uint32_t **ints) {
  return (int64_t) uint32s_to_uint64(ints);
}

static int uint32s_to_timespec (struct timespec* ts, uint32_t** ints) {
  int64_t seconds = uint32s_to_int64(ints);
  uint32_t nanoseconds = *((*ints)++);
  ts->tv_sec = (time_t) seconds;
  ts->tv_nsec = (long) nanoseconds;
  if ((int64_t) ts->tv_sec != seconds ||
      nanoseconds > 999999999U ||
      (uint32_t) ts->tv_nsec != nanoseconds) {
    return -ERANGE;
  }
  return 0;
}

static int populate_stat (uint32_t *ints, struct stat* stat) {
  memset(stat, 0, sizeof(*stat));
  uint32_t mode = *ints++;
  stat->st_mode = (mode_t) mode;
  if ((uint32_t) stat->st_mode != mode) return -ERANGE;
  stat->st_uid = *ints++;
  stat->st_gid = *ints++;
  int64_t size = uint32s_to_int64(&ints);
  uint64_t dev = uint32s_to_uint64(&ints);
  uint64_t nlink = uint32s_to_uint64(&ints);
  uint64_t ino = uint32s_to_uint64(&ints);
  uint64_t rdev = uint32s_to_uint64(&ints);
  uint64_t blksize = uint32s_to_uint64(&ints);
  uint64_t blocks = uint32s_to_uint64(&ints);
  stat->st_size = (off_t) size;
  stat->st_dev = (dev_t) dev;
  stat->st_nlink = (nlink_t) nlink;
  stat->st_ino = (ino_t) ino;
  stat->st_rdev = (dev_t) rdev;
  stat->st_blksize = (blksize_t) blksize;
  stat->st_blocks = (blkcnt_t) blocks;
  if (size < 0 || (int64_t) stat->st_size != size ||
      (uint64_t) stat->st_dev != dev ||
      (uint64_t) stat->st_nlink != nlink ||
      (uint64_t) stat->st_ino != ino ||
      (uint64_t) stat->st_rdev != rdev ||
      stat->st_blksize < 0 || (uint64_t) stat->st_blksize != blksize ||
      stat->st_blocks < 0 || (uint64_t) stat->st_blocks != blocks) {
    return -ERANGE;
  }
#ifdef __APPLE__
  if (uint32s_to_timespec(&stat->st_atimespec, &ints) != 0 ||
      uint32s_to_timespec(&stat->st_mtimespec, &ints) != 0 ||
      uint32s_to_timespec(&stat->st_ctimespec, &ints) != 0) {
    return -ERANGE;
  }
#else
  if (uint32s_to_timespec(&stat->st_atim, &ints) != 0 ||
      uint32s_to_timespec(&stat->st_mtim, &ints) != 0 ||
      uint32s_to_timespec(&stat->st_ctim, &ints) != 0) {
    return -ERANGE;
  }
#endif
  return 0;
}

static int populate_statvfs (uint32_t *ints, struct statvfs* statvfs) {
  memset(statvfs, 0, sizeof(*statvfs));
  uint64_t bsize = uint32s_to_uint64(&ints);
  uint64_t frsize = uint32s_to_uint64(&ints);
  uint64_t blocks = uint32s_to_uint64(&ints);
  uint64_t bfree = uint32s_to_uint64(&ints);
  uint64_t bavail = uint32s_to_uint64(&ints);
  uint64_t files = uint32s_to_uint64(&ints);
  uint64_t ffree = uint32s_to_uint64(&ints);
  uint64_t favail = uint32s_to_uint64(&ints);
  uint64_t fsid = uint32s_to_uint64(&ints);
  uint64_t flag = uint32s_to_uint64(&ints);
  uint64_t namemax = uint32s_to_uint64(&ints);
  statvfs->f_bsize = (unsigned long) bsize;
  statvfs->f_frsize = (unsigned long) frsize;
  statvfs->f_blocks = (fsblkcnt_t) blocks;
  statvfs->f_bfree = (fsblkcnt_t) bfree;
  statvfs->f_bavail = (fsblkcnt_t) bavail;
  statvfs->f_files = (fsfilcnt_t) files;
  statvfs->f_ffree = (fsfilcnt_t) ffree;
  statvfs->f_favail = (fsfilcnt_t) favail;
  statvfs->f_fsid = (unsigned long) fsid;
  statvfs->f_flag = (unsigned long) flag;
  statvfs->f_namemax = (unsigned long) namemax;
  if ((uint64_t) statvfs->f_bsize != bsize ||
      (uint64_t) statvfs->f_frsize != frsize ||
      (uint64_t) statvfs->f_blocks != blocks ||
      (uint64_t) statvfs->f_bfree != bfree ||
      (uint64_t) statvfs->f_bavail != bavail ||
      (uint64_t) statvfs->f_files != files ||
      (uint64_t) statvfs->f_ffree != ffree ||
      (uint64_t) statvfs->f_favail != favail ||
      (uint64_t) statvfs->f_fsid != fsid ||
      (uint64_t) statvfs->f_flag != flag ||
      (uint64_t) statvfs->f_namemax != namemax) {
    return -ERANGE;
  }
  return 0;
}

#if defined(__APPLE__) && FUSE_DARWIN_ENABLE_EXTENSIONS
static void stat_to_darwin_attr (
  const struct stat *source,
  struct fuse_darwin_attr *destination
) {
  memset(destination, 0, sizeof(*destination));
  destination->ino = source->st_ino;
  destination->mode = source->st_mode;
  destination->nlink = source->st_nlink;
  destination->uid = source->st_uid;
  destination->gid = source->st_gid;
  destination->rdev = source->st_rdev;
  destination->atimespec = source->st_atimespec;
  destination->mtimespec = source->st_mtimespec;
  destination->ctimespec = source->st_ctimespec;
  destination->btimespec = source->st_birthtimespec;
  destination->size = source->st_size;
  destination->blocks = source->st_blocks;
  destination->blksize = source->st_blksize;
  destination->flags = source->st_flags;
}

static int statvfs_to_darwin_statfs (
  const struct statvfs *source,
  struct statfs *destination
) {
  unsigned long io_size =
    source->f_frsize == 0 ? source->f_bsize : source->f_frsize;
  if (source->f_bsize > UINT32_MAX || io_size > INT32_MAX) {
    return -ERANGE;
  }

  memset(destination, 0, sizeof(*destination));
  destination->f_bsize = (uint32_t) source->f_bsize;
  destination->f_iosize = (int32_t) io_size;
  destination->f_blocks = (uint64_t) source->f_blocks;
  destination->f_bfree = (uint64_t) source->f_bfree;
  destination->f_bavail = (uint64_t) source->f_bavail;
  destination->f_files = (uint64_t) source->f_files;
  destination->f_ffree = (uint64_t) source->f_ffree;
  return 0;
}
#endif

static int fuse_native_fill_directory_entry (
  fuse_native_fill_dir_t filler,
  void *buffer,
  const char *name,
  const struct stat *stat,
  off_t next_offset
) {
#if defined(__APPLE__) && FUSE_DARWIN_ENABLE_EXTENSIONS
  struct fuse_darwin_attr darwin_attr = {0};
  struct fuse_darwin_attr *darwin_attr_ptr = NULL;
  if (stat != NULL) {
    stat_to_darwin_attr(stat, &darwin_attr);
    darwin_attr_ptr = &darwin_attr;
  }
  return filler(
    buffer,
    name,
    darwin_attr_ptr,
    next_offset,
    (enum fuse_fill_dir_flags) 0
  );
#else
  return filler(
    buffer,
    name,
    stat,
    next_offset,
    (enum fuse_fill_dir_flags) 0
  );
#endif
}

static napi_status create_uint64_value (napi_env env, uint64_t value, napi_value *result) {
  if (value <= 9007199254740991ULL) {
    return napi_create_double(env, (double) value, result);
  }
  return napi_create_bigint_uint64(env, value, result);
}

static int value_to_uint64 (napi_env env, napi_value value, uint64_t *result) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) return -1;

  if (type == napi_bigint) {
    bool lossless = false;
    if (napi_get_value_bigint_uint64(env, value, result, &lossless) != napi_ok || !lossless) return -1;
    return 0;
  }

  if (type == napi_number) {
    double number;
    if (napi_get_value_double(env, value, &number) != napi_ok) return -1;
    if (!isfinite(number) || number < 0 || number > 9007199254740991.0 || floor(number) != number) return -1;
    *result = (uint64_t) number;
    return 0;
  }

  return -1;
}

static int get_uint32_array (napi_env env, napi_value value, uint32_t **data, size_t *length) {
  bool is_typedarray = false;
  napi_typedarray_type type;
  size_t elements = 0;
  napi_value arraybuffer;
  size_t byte_offset = 0;
  void *raw_data = NULL;

  if (napi_is_typedarray(env, value, &is_typedarray) != napi_ok || !is_typedarray) return -1;
  if (napi_get_typedarray_info(
        env, value, &type, &elements, &raw_data, &arraybuffer, &byte_offset
      ) != napi_ok ||
      type != napi_uint32_array ||
      byte_offset % sizeof(uint32_t) != 0) {
    return -1;
  }

  *data = (uint32_t *) raw_data;
  *length = elements;
  return 0;
}

static int value_to_int64_words (napi_env env, napi_value value, int64_t *result) {
  uint32_t *words = NULL;
  size_t length = 0;
  if (get_uint32_array(env, value, &words, &length) != 0 || length != 2) {
    return -1;
  }
  uint32_t *cursor = words;
  *result = uint32s_to_int64(&cursor);
  return 0;
}

static napi_status create_owned_buffer (
  napi_env env,
  const void *source,
  size_t length,
  napi_value *result
) {
  void *data = NULL;
  napi_status status = napi_create_buffer(env, length, &data, result);
  if (status == napi_ok && source != NULL && length > 0) memcpy(data, source, length);
  return status;
}

static int copy_owned_buffer (
  napi_env env,
  napi_value value,
  void *destination,
  size_t capacity,
  size_t length
) {
  bool is_buffer = false;
  void *data = NULL;
  size_t buffer_length = 0;
  if (length > capacity || (length > 0 && destination == NULL)) return -ERANGE;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok ||
      !is_buffer ||
      napi_get_buffer_info(env, value, &data, &buffer_length) != napi_ok ||
      buffer_length < length) {
    return -EIO;
  }
  if (length > 0) memcpy(destination, data, length);
  return 0;
}

static int int64_to_off_t (int64_t value, off_t *result) {
  *result = (off_t) value;
  return (int64_t) *result == value ? 0 : -ERANGE;
}

/*
 * Darwin and Linux encode UTIME_NOW/UTIME_OMIT differently.  The public
 * JavaScript constants remain platform-neutral, so normalize at the native
 * boundary.
 */
static uint32_t fuse_native_timespec_nanoseconds (long nanoseconds) {
  if (nanoseconds == UTIME_NOW) return UINT32_C(0x3fffffff);
  if (nanoseconds == UTIME_OMIT) return UINT32_C(0x3ffffffe);
  return (uint32_t) nanoseconds;
}

// Methods

FUSE_METHOD(statfs, 1, 1, (const char * path, struct statvfs *statvfs), {
  l->path = path;
  l->statvfs = statvfs;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
}, {
  uint32_t *ints = NULL;
  size_t ints_length = 0;
  if (res == 0 && (get_uint32_array(env, argv[2], &ints, &ints_length) != 0 || ints_length != 22)) {
    res = -EIO;
  } else if (res == 0) {
    res = populate_statvfs(ints, l->statvfs);
  }
})

#if defined(__APPLE__) && FUSE_DARWIN_ENABLE_EXTENSIONS
static int fuse_native_statfs_darwin (
  const char *path,
  struct statfs *statfs
) {
  struct statvfs portable_stat = {0};
  int result = fuse_native_statfs(path, &portable_stat);
  if (result != 0) return result;
  return statvfs_to_darwin_statfs(&portable_stat, statfs);
}
#endif

FUSE_METHOD(getattr, 1, 1, (const char *path, struct stat *stat), {
  l->path = path;
  l->stat = stat;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
}, {
  uint32_t *ints = NULL;
  size_t ints_length = 0;
  if (res == 0 && (get_uint32_array(env, argv[2], &ints, &ints_length) != 0 || ints_length != 26)) {
    res = -EIO;
  } else if (res == 0) {
    res = populate_stat(ints, l->stat);
  }
})

FUSE_METHOD(fgetattr, 2, 1, (const char *path, struct stat *stat, struct fuse_file_info *info), {
  l->path = path;
  l->stat = stat;
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  if (l->info != NULL) {
    FUSE_CREATE_UINT64_ARGV(l->info->fh, 3)
  } else {
    FUSE_CREATE_UINT64_ARGV(0, 3)
  }
}, {
  uint32_t *ints = NULL;
  size_t ints_length = 0;
  if (res == 0 && (get_uint32_array(env, argv[2], &ints, &ints_length) != 0 || ints_length != 26)) {
    res = -EIO;
  } else if (res == 0) {
    res = populate_stat(ints, l->stat);
  }
})

/*
 * libfuse 3 merged getattr/fgetattr into one operation.  Preserve both
 * JavaScript handlers and select the handle-aware variant whenever libfuse
 * supplies file information.
 */
#if defined(__APPLE__) && FUSE_DARWIN_ENABLE_EXTENSIONS
static int fuse_native_getattr_v3 (
  const char *path,
  struct fuse_darwin_attr *attr,
  struct fuse_file_info *info
) {
  struct stat portable_stat = {0};
  struct fuse_context *context = fuse_get_context();
  fuse_thread_t *ft = context == NULL
    ? NULL
    : (fuse_thread_t *) context->private_data;
  int result = -ENOSYS;
  if (info != NULL && ft != NULL && ft->implemented[op_fgetattr]) {
    result = fuse_native_fgetattr(path, &portable_stat, info);
  } else if (ft != NULL && ft->implemented[op_getattr]) {
    result = fuse_native_getattr(path, &portable_stat);
  }
  if (result == 0) stat_to_darwin_attr(&portable_stat, attr);
  return result;
}
#else
static int fuse_native_getattr_v3 (
  const char *path,
  struct stat *stat,
  struct fuse_file_info *info
) {
  struct fuse_context *context = fuse_get_context();
  fuse_thread_t *ft = context == NULL
    ? NULL
    : (fuse_thread_t *) context->private_data;
  if (info != NULL && ft != NULL && ft->implemented[op_fgetattr]) {
    return fuse_native_fgetattr(path, stat, info);
  }
  if (ft != NULL && ft->implemented[op_getattr]) {
    return fuse_native_getattr(path, stat);
  }
  return -ENOSYS;
}
#endif

FUSE_METHOD_VOID(access, 2, 0, (const char *path, int mode), {
  l->path = path;
  l->int_value = mode;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  napi_create_int32(env, l->int_value, &(argv[3]));
})

#define FUSE_FILE_INFO_DIRECT_IO 1U
#define FUSE_FILE_INFO_KEEP_CACHE 2U
/*
 * fuse_file_info.backing_id appeared in libfuse 3.17. Compiling against an
 * older header is still supported; passthrough is simply never offered.
 */
#if defined(__linux__) && FUSE_VERSION >= 317
#define FUSE_HAS_BACKING_ID 1
#define FUSE_SET_BACKING_ID(info, id) (info)->backing_id = (int32_t) (id);
#else
#define FUSE_HAS_BACKING_ID 0
#define FUSE_SET_BACKING_ID(info, id) (void) (id);
#endif

#define FUSE_FILE_INFO_NONSEEKABLE 4U
#define FUSE_FILE_INFO_ALLOWED_FLAGS \
  (FUSE_FILE_INFO_DIRECT_IO | FUSE_FILE_INFO_KEEP_CACHE | FUSE_FILE_INFO_NONSEEKABLE)

/*
 * argv[4] carries an optional backing id from backingOpen(). libfuse sets
 * FOPEN_PASSTHROUGH whenever backing_id > 0, which the kernel rejects if
 * keep_cache is also set (fs/fuse/iomode.c), so that combination is refused
 * here rather than surfacing as an EIO from open().
 */
#define FUSE_APPLY_FILE_INFO_RESULT()\
  uint64_t fd = 0;\
  uint32_t result_flags = 0;\
  uint32_t backing_id = 0;\
  if (res == 0 &&\
      (value_to_uint64(env, argv[2], &fd) != 0 ||\
       napi_get_value_uint32(env, argv[3], &result_flags) != napi_ok ||\
       (result_flags & ~FUSE_FILE_INFO_ALLOWED_FLAGS) != 0)) {\
    res = -EINVAL;\
  }\
  if (res == 0) {\
    napi_valuetype backing_type = napi_undefined;\
    if (napi_typeof(env, argv[4], &backing_type) == napi_ok &&\
        backing_type == napi_number &&\
        napi_get_value_uint32(env, argv[4], &backing_id) != napi_ok) {\
      res = -EINVAL;\
    }\
  }\
  if (res == 0 && backing_id > 0 &&\
      (result_flags & (FUSE_FILE_INFO_KEEP_CACHE | FUSE_FILE_INFO_DIRECT_IO)) != 0) {\
    res = -EINVAL;\
  }\
  if (res == 0 && l->info != NULL) {\
    l->info->fh = fd;\
    l->info->direct_io = (result_flags & FUSE_FILE_INFO_DIRECT_IO) != 0;\
    l->info->keep_cache = (result_flags & FUSE_FILE_INFO_KEEP_CACHE) != 0;\
    l->info->nonseekable = (result_flags & FUSE_FILE_INFO_NONSEEKABLE) != 0;\
    FUSE_SET_BACKING_ID(l->info, backing_id)\
  }

FUSE_METHOD(open, 2, 3, (const char *path, struct fuse_file_info *info), {
  l->path = path;
  l->info = info;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  if (l->info != NULL) {
    napi_create_int32(env, l->info->flags, &(argv[3]));
  } else {
    napi_create_uint32(env, 0, &(argv[3]));
  }
}, {
  FUSE_APPLY_FILE_INFO_RESULT()
})

FUSE_METHOD(opendir, 2, 3, (const char *path, struct fuse_file_info *info), {
  l->path = path;
  l->info = info;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  if (l->info != NULL) {
    napi_create_int32(env, l->info->flags, &(argv[3]));
  } else {
    napi_create_uint32(env, 0, &(argv[3]));
  }
}, {
  FUSE_APPLY_FILE_INFO_RESULT()
})

FUSE_METHOD(create, 3, 3, (const char *path, mode_t mode, struct fuse_file_info *info), {
  l->path = path;
  l->mode = mode;
  l->info = info;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  napi_create_uint32(env, l->mode, &(argv[3]));
  if (l->info != NULL) {
    napi_create_int32(env, l->info->flags, &(argv[4]));
  } else {
    napi_create_uint32(env, 0, &(argv[4]));
  }
}, {
  FUSE_APPLY_FILE_INFO_RESULT()
})

FUSE_METHOD_VOID(utimens, 8, 0, (
  const char *path,
  const struct timespec tv[2],
  struct fuse_file_info *info
), {
  l->path = path;
  l->atime = tv[0];
  l->mtime = tv[1];
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  FUSE_UINT64_TO_INTS_ARGV(l->atime.tv_sec, 3)
  napi_create_uint32(
    env,
    fuse_native_timespec_nanoseconds(l->atime.tv_nsec),
    &(argv[5])
  );
  FUSE_UINT64_TO_INTS_ARGV(l->mtime.tv_sec, 6)
  napi_create_uint32(
    env,
    fuse_native_timespec_nanoseconds(l->mtime.tv_nsec),
    &(argv[8])
  );
  FUSE_CREATE_FILE_HANDLE_ARGV(9)
})

FUSE_METHOD_VOID(release, 2, 0, (const char *path, struct fuse_file_info *info), {
  l->path = path;
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  if (l->info != NULL) {
    FUSE_CREATE_UINT64_ARGV(l->info->fh, 3)
  } else {
    FUSE_CREATE_UINT64_ARGV(0, 3)
  }
})

FUSE_METHOD_VOID(releasedir, 2, 0, (const char *path, struct fuse_file_info *info), {
  l->path = path;
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  if (l->info != NULL) {
    FUSE_CREATE_UINT64_ARGV(l->info->fh, 3)
  } else {
    FUSE_CREATE_UINT64_ARGV(0, 3)
  }
})

FUSE_METHOD(read, 6, 1, (const char *path, char *buf, size_t len, off_t offset, struct fuse_file_info *info), {
  if (len > UINT32_MAX) return -EOVERFLOW;
  l->path = path;
  l->buf = buf;
  l->len = len;
  l->offset = offset;
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  FUSE_CREATE_FILE_HANDLE_ARGV(3)
  FUSE_CREATE_OWNED_BUFFER_ARGV(NULL, l->len, 4)
  napi_create_uint32(env, (uint32_t) l->len, &(argv[5]));
  FUSE_UINT64_TO_INTS_ARGV(l->offset, 6)
}, {
  if (res > 0) {
    if ((size_t) res > l->len) {
      res = -EIO;
    } else {
      int copy_result = copy_owned_buffer(env, argv[2], (void *) l->buf, l->len, (size_t) res);
      if (copy_result != 0) res = copy_result;
    }
  }
})

FUSE_METHOD(write, 6, 0, (const char *path, const char *buf, size_t len, off_t offset, struct fuse_file_info *info), {
  if (len > UINT32_MAX) return -EOVERFLOW;
  l->path = path;
  l->buf = buf;
  l->len = len;
  l->offset = offset;
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  FUSE_CREATE_FILE_HANDLE_ARGV(3)
  FUSE_CREATE_OWNED_BUFFER_ARGV(l->buf, l->len, 4)
  napi_create_uint32(env, (uint32_t) l->len, &(argv[5]));
  FUSE_UINT64_TO_INTS_ARGV(l->offset, 6)
}, {
  if (res > 0 && (size_t) res > l->len) res = -EIO;
})

FUSE_METHOD(readdir, 4, 3, (
  const char *path,
  void *buf,
  fuse_native_fill_dir_t filler,
  off_t offset,
  struct fuse_file_info *info,
  enum fuse_readdir_flags flags
), {
  (void) flags;
  l->buf = buf;
  l->path = path;
  l->offset = offset;
  l->info = info;
  l->readdir_filler = filler;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  if (l->info != NULL) {
    FUSE_CREATE_UINT64_ARGV(l->info->fh, 3)
  } else {
    FUSE_CREATE_UINT64_ARGV(0, 3)
  }
  FUSE_UINT64_TO_INTS_ARGV(l->offset, 4)
}, {
  bool names_is_array = false;
  bool stats_is_array = false;
  uint32_t names_length = 0;
  uint32_t stats_length = 0;
  uint32_t *offsets = NULL;
  size_t offsets_length = 0;

  if (res == 0 &&
      (napi_is_array(env, argv[2], &names_is_array) != napi_ok ||
       napi_is_array(env, argv[3], &stats_is_array) != napi_ok ||
       !names_is_array ||
       !stats_is_array ||
       napi_get_array_length(env, argv[2], &names_length) != napi_ok ||
       napi_get_array_length(env, argv[3], &stats_length) != napi_ok ||
       (stats_length != 0 && stats_length != names_length) ||
       get_uint32_array(env, argv[4], &offsets, &offsets_length) != 0 ||
       (offsets_length != 0 && offsets_length != (size_t) names_length * 2))) {
    res = -EIO;
  }

  for (uint32_t i = 0; res == 0 && i < names_length; i++) {
    napi_value raw_name;
    size_t name_length = 0;
    char name[256];
    if (napi_get_element(env, argv[2], i, &raw_name) != napi_ok ||
        napi_get_value_string_utf8(env, raw_name, NULL, 0, &name_length) != napi_ok ||
        name_length > 255 ||
        napi_get_value_string_utf8(env, raw_name, name, sizeof(name), &name_length) != napi_ok) {
      res = -EIO;
      break;
    }

    struct stat st = {0};
    struct stat *stat_ptr = NULL;
    if (stats_length != 0) {
      napi_value raw_stat;
      uint32_t *stats_array = NULL;
      size_t stats_array_length = 0;
      if (napi_get_element(env, argv[3], i, &raw_stat) != napi_ok ||
          get_uint32_array(env, raw_stat, &stats_array, &stats_array_length) != 0 ||
          stats_array_length != 26) {
        res = -EIO;
        break;
      }
      int stat_result = populate_stat(stats_array, &st);
      if (stat_result != 0) {
        res = stat_result;
        break;
      }
      stat_ptr = &st;
    }

    off_t next_offset = 0;
    if (offsets_length != 0) {
      uint32_t *offset_parts = &(offsets[(size_t) i * 2]);
      int64_t encoded_offset = uint32s_to_int64(&offset_parts);
      if (encoded_offset == 0 || int64_to_off_t(encoded_offset, &next_offset) != 0) {
        res = -EIO;
        break;
      }
    }

    if (fuse_native_fill_directory_entry(
          l->readdir_filler,
          (char *) l->buf,
          name,
          stat_ptr,
          next_offset
        ) != 0) break;
  }
})

#if defined(__APPLE__) && FUSE_DARWIN_ENABLE_EXTENSIONS

FUSE_METHOD(setxattr, 5, 0, (const char *path, const char *name, const char *value, size_t size, int flags, uint32_t position), {
  l->path = path;
  l->name = name;
  l->value = value;
  l->size = size;
  l->flags = flags;
  l->position = position;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  napi_create_string_utf8(env, l->name, NAPI_AUTO_LENGTH, &(argv[3]));
  FUSE_CREATE_OWNED_BUFFER_ARGV(l->value, l->size, 4)
  napi_create_uint32(env, l->position, &(argv[5]));
  napi_create_int32(env, l->flags, &(argv[6]));
}, {
  if (res > 0) res = -EIO;
})

FUSE_METHOD(getxattr, 4, 1, (const char *path, const char *name, char *value, size_t size, uint32_t position), {
  l->path = path;
  l->name = name;
  l->value = value;
  l->size = size;
  l->position = position;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  napi_create_string_utf8(env, l->name, NAPI_AUTO_LENGTH, &(argv[3]));
  FUSE_CREATE_OWNED_BUFFER_ARGV(NULL, l->size, 4)
  napi_create_uint32(env, l->position, &(argv[5]));
}, {
  if (l->size > 0 && res > 0) {
    if ((size_t) res > l->size) {
      res = -ERANGE;
    } else {
      int copy_result = copy_owned_buffer(env, argv[2], (void *) l->value, l->size, (size_t) res);
      if (copy_result != 0) res = copy_result;
    }
  }
})

#else

FUSE_METHOD(setxattr, 5, 0, (const char *path, const char *name, const char *value, size_t size, int flags), {
  l->path = path;
  l->name = name;
  l->value = value;
  l->size = size;
  l->flags = flags;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  napi_create_string_utf8(env, l->name, NAPI_AUTO_LENGTH, &(argv[3]));
  FUSE_CREATE_OWNED_BUFFER_ARGV(l->value, l->size, 4)
  napi_create_uint32(env, 0, &(argv[5])); // normalize apis between mac and linux
  napi_create_int32(env, l->flags, &(argv[6]));
}, {
  if (res > 0) res = -EIO;
})

FUSE_METHOD(getxattr, 4, 1, (const char *path, const char *name, char *value, size_t size), {
  l->path = path;
  l->name = name;
  l->value = value;
  l->size = size;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  napi_create_string_utf8(env, l->name, NAPI_AUTO_LENGTH, &(argv[3]));
  FUSE_CREATE_OWNED_BUFFER_ARGV(NULL, l->size, 4)
  napi_create_uint32(env, 0, &(argv[5]));
}, {
  if (l->size > 0 && res > 0) {
    if ((size_t) res > l->size) {
      res = -ERANGE;
    } else {
      int copy_result = copy_owned_buffer(env, argv[2], (void *) l->value, l->size, (size_t) res);
      if (copy_result != 0) res = copy_result;
    }
  }
})

#endif

FUSE_METHOD(listxattr, 2, 1, (const char *path, char *list, size_t size), {
  l->path = path;
  l->list = list;
  l->size = size;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  FUSE_CREATE_OWNED_BUFFER_ARGV(NULL, l->size, 3)
}, {
  if (l->size > 0 && res > 0) {
    if ((size_t) res > l->size) {
      res = -ERANGE;
    } else {
      int copy_result = copy_owned_buffer(env, argv[2], l->list, l->size, (size_t) res);
      if (copy_result != 0) res = copy_result;
    }
  }
})

FUSE_METHOD_VOID(removexattr, 2, 0, (const char *path, const char *name), {
  l->path = path;
  l->name = name;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  napi_create_string_utf8(env, l->name, NAPI_AUTO_LENGTH, &(argv[3]));
})

FUSE_METHOD_VOID(flush, 2, 0, (const char *path, struct fuse_file_info *info), {
  l->path = path;
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  if (l->info != NULL) {
    FUSE_CREATE_UINT64_ARGV(l->info->fh, 3)
  } else {
    FUSE_CREATE_UINT64_ARGV(0, 3)
  }
})

FUSE_METHOD_VOID(fsync, 3, 0, (const char *path, int datasync, struct fuse_file_info *info), {
  l->path = path;
  l->int_value = datasync;
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  napi_create_int32(env, l->int_value, &(argv[3]));
  if (l->info != NULL) {
    FUSE_CREATE_UINT64_ARGV(l->info->fh, 4)
  } else {
    FUSE_CREATE_UINT64_ARGV(0, 4)
  }
})

FUSE_METHOD_VOID(fsyncdir, 3, 0, (const char *path, int datasync, struct fuse_file_info *info), {
  l->path = path;
  l->int_value = datasync;
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  napi_create_int32(env, l->int_value, &(argv[3]));
  if (l->info != NULL) {
    FUSE_CREATE_UINT64_ARGV(l->info->fh, 4)
  } else {
    FUSE_CREATE_UINT64_ARGV(0, 4)
  }
})


FUSE_METHOD_VOID(truncate, 3, 0, (const char *path, off_t size), {
  l->path = path;
  l->offset = size;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  FUSE_UINT64_TO_INTS_ARGV(l->offset, 3)
})

FUSE_METHOD_VOID(ftruncate, 4, 0, (const char *path, off_t size, struct fuse_file_info *info), {
  l->path = path;
  l->offset = size;
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  if (l->info != NULL) {
    FUSE_CREATE_UINT64_ARGV(l->info->fh, 3)
  } else {
    FUSE_CREATE_UINT64_ARGV(0, 3)
  }
  FUSE_UINT64_TO_INTS_ARGV(l->offset, 4)
})

/*
 * libfuse 3 merged truncate/ftruncate in the same way as getattr.  Route to
 * the existing JavaScript-facing operation to keep the 1.x handler contract.
 */
static int fuse_native_truncate_v3 (
  const char *path,
  off_t size,
  struct fuse_file_info *info
) {
  struct fuse_context *context = fuse_get_context();
  fuse_thread_t *ft = context == NULL
    ? NULL
    : (fuse_thread_t *) context->private_data;
  if (info != NULL && ft != NULL && ft->implemented[op_ftruncate]) {
    return fuse_native_ftruncate(path, size, info);
  }
  if (ft != NULL && ft->implemented[op_truncate]) {
    return fuse_native_truncate(path, size);
  }
  return -ENOSYS;
}

static size_t fuse_native_readlink_capacity (size_t len) {
#ifdef __linux__
  /*
   * libfuse provides PATH_MAX + 1 bytes here, but the Linux kernel rejects
   * a FUSE readlink reply with PATH_MAX payload bytes. Reserve one extra
   * byte so Node-API emits at most the kernel-supported PATH_MAX - 1 bytes.
   */
  if (len > 1) return len - 1;
#endif
  /* macFUSE accepts PATH_MAX payload bytes and uses the complete capacity. */
  return len;
}

FUSE_METHOD(readlink, 1, 1, (const char *path, char *linkname, size_t len), {
  l->path = path;
  l->linkname = linkname;
  l->len = len;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
}, {
  if (res == 0) {
    size_t linkname_length = 0;
    size_t linkname_capacity = fuse_native_readlink_capacity(l->len);
    if (l->len == 0 ||
        napi_get_value_string_utf8(
          env, argv[2], l->linkname, linkname_capacity, &linkname_length
        ) != napi_ok) {
      res = -EIO;
    }
  }
})

FUSE_METHOD_VOID(chown, 4, 0, (
  const char *path,
  uid_t uid,
  gid_t gid,
  struct fuse_file_info *info
), {
  l->path = path;
  l->uid = uid;
  l->gid = gid;
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  napi_create_uint32(env, l->uid, &(argv[3]));
  napi_create_uint32(env, l->gid, &(argv[4]));
  FUSE_CREATE_FILE_HANDLE_ARGV(5)
})

FUSE_METHOD_VOID(chmod, 3, 0, (
  const char *path,
  mode_t mode,
  struct fuse_file_info *info
), {
  l->path = path;
  l->mode = mode;
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  napi_create_uint32(env, l->mode, &(argv[3]));
  FUSE_CREATE_FILE_HANDLE_ARGV(4)
})

FUSE_METHOD_VOID(mknod, 3, 0, (const char *path, mode_t mode, dev_t dev), {
  l->path = path;
  l->mode = mode;
  l->dev = dev;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  napi_create_uint32(env, l->mode, &(argv[3]));
  FUSE_CREATE_UINT64_ARGV(l->dev, 4)
})

FUSE_METHOD_VOID(unlink, 1, 0, (const char *path), {
  l->path = path;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
})

FUSE_METHOD_VOID(rename, 3, 0, (
  const char *path,
  const char *dest,
  unsigned int flags
), {
  l->path = path;
  l->dest = dest;
  l->flags = (int) flags;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  napi_create_string_utf8(env, l->dest, NAPI_AUTO_LENGTH, &(argv[3]));
  napi_create_uint32(env, (uint32_t) l->flags, &(argv[4]));
})

FUSE_METHOD_VOID(link, 2, 0, (const char *path, const char *dest), {
  l->path = path;
  l->dest = dest;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  napi_create_string_utf8(env, l->dest, NAPI_AUTO_LENGTH, &(argv[3]));
})

FUSE_METHOD_VOID(symlink, 2, 0, (const char *path, const char *dest), {
  l->path = path;
  l->dest = dest;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  napi_create_string_utf8(env, l->dest, NAPI_AUTO_LENGTH, &(argv[3]));
})

FUSE_METHOD_VOID(mkdir, 2, 0, (const char *path, mode_t mode), {
  l->path = path;
  l->mode = mode;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  napi_create_uint32(env, l->mode, &(argv[3]));
})

FUSE_METHOD_VOID(rmdir, 1, 0, (const char *path), {
  l->path = path;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
})

#if defined(__APPLE__) && FUSE_DARWIN_ENABLE_EXTENSIONS
/*
 * macFUSE 3 combines Darwin metadata mutations in setattr.  Execute the
 * existing portable handlers in a stable order so a 1.x filesystem keeps its
 * chmod/chown/truncate/utimens behavior without learning a platform-only API.
 */
static int fuse_native_setattr_darwin (
  const char *path,
  struct fuse_darwin_attr *attr,
  int to_set,
  struct fuse_file_info *info
) {
  struct fuse_context *context = fuse_get_context();
  fuse_thread_t *ft = context == NULL
    ? NULL
    : (fuse_thread_t *) context->private_data;
  if (ft == NULL || attr == NULL) return -EIO;

  uint32_t requested = (uint32_t) to_set;
  uint32_t unsupported =
    (uint32_t) FUSE_SET_ATTR_BTIME |
    (uint32_t) FUSE_SET_ATTR_BKUPTIME |
    (uint32_t) FUSE_SET_ATTR_FLAGS;
  if ((requested & unsupported) != 0) return -EOPNOTSUPP;

  int result = 0;
  if ((requested & FUSE_SET_ATTR_MODE) != 0) {
    if (!ft->implemented[op_chmod]) return -ENOSYS;
    result = fuse_native_chmod(path, attr->mode, info);
    if (result != 0) return result;
  }

  if ((requested & (FUSE_SET_ATTR_UID | FUSE_SET_ATTR_GID)) != 0) {
    if (!ft->implemented[op_chown]) return -ENOSYS;
    uid_t uid = (requested & FUSE_SET_ATTR_UID) != 0
      ? attr->uid
      : (uid_t) -1;
    gid_t gid = (requested & FUSE_SET_ATTR_GID) != 0
      ? attr->gid
      : (gid_t) -1;
    result = fuse_native_chown(path, uid, gid, info);
    if (result != 0) return result;
  }

  if ((requested & FUSE_SET_ATTR_SIZE) != 0) {
    result = fuse_native_truncate_v3(path, attr->size, info);
    if (result != 0) return result;
  }

  if ((requested & (FUSE_SET_ATTR_ATIME | FUSE_SET_ATTR_MTIME |
                    FUSE_SET_ATTR_ATIME_NOW |
                    FUSE_SET_ATTR_MTIME_NOW)) != 0) {
    if (!ft->implemented[op_utimens]) return -ENOSYS;
    struct timespec times[3] = {
      {.tv_sec = 0, .tv_nsec = UTIME_OMIT},
      {.tv_sec = 0, .tv_nsec = UTIME_OMIT},
      {.tv_sec = 0, .tv_nsec = UTIME_OMIT}
    };
    if ((requested & FUSE_SET_ATTR_ATIME_NOW) != 0) {
      times[0].tv_nsec = UTIME_NOW;
    } else if ((requested & FUSE_SET_ATTR_ATIME) != 0) {
      times[0] = attr->atimespec;
    }
    if ((requested & FUSE_SET_ATTR_MTIME_NOW) != 0) {
      times[1].tv_nsec = UTIME_NOW;
    } else if ((requested & FUSE_SET_ATTR_MTIME) != 0) {
      times[1] = attr->mtimespec;
    }
    result = fuse_native_utimens(path, times, info);
    if (result != 0) return result;
  }

  return 0;
}
#endif

static void fuse_native_dispatch_destroy (
  uv_async_t* handle,
  fuse_thread_locals_t* l,
  fuse_thread_t* ft
) {
  (void) handle;
  FUSE_NATIVE_CALLBACK(ft->handlers[op_destroy], {
    napi_value argv[3] = {0};
    if (initialize_callback_arguments(env, argv, 3) != napi_ok ||
        napi_get_reference_value(env, l->self, &(argv[0])) != napi_ok ||
        napi_create_uint32(env, l->op, &(argv[1])) != napi_ok ||
        create_request_context_value(env, l, &(argv[2])) != napi_ok) {
      napi_close_handle_scope(env, scope);
      fuse_native_complete_local(l, -EIO);
      return;
    }
    FUSE_CALL_CALLBACK(3, argv)
  })
}

NAPI_METHOD(fuse_native_signal_destroy) {
  NAPI_ARGV(2)
  NAPI_ARGV_BUFFER_CAST(fuse_thread_locals_t *, l, 0);
  NAPI_ARGV_INT32(res, 1);
  fuse_native_complete_local(l, res);
  return NULL;
}

static void fuse_native_destroy (void *data) {
  fuse_thread_t *ft = (fuse_thread_t *) data;
  if (ft == NULL || !ft->thread_started || ft->env_cleanup) return;

  fuse_thread_locals_t *l =
    (fuse_thread_locals_t *) pthread_getspecific(thread_locals_key);
  if (l == NULL) l = ft->locals;
  if (l == NULL) return;
  fuse_native_capture_context(l);
  l->info = NULL;
  l->owned_input = NULL;
  l->pollhandle = NULL;
  l->op = op_destroy;
  l->op_fn = fuse_native_dispatch_destroy;
  atomic_store(&(l->waiting), 1);
  if (fuse_native_schedule_local(l) < 0) {
    atomic_store(&(l->waiting), 0);
    return;
  }
  uv_sem_wait(&(l->sem));
}

FUSE_METHOD(lock, 10, 1, (
  const char *path,
  struct fuse_file_info *info,
  int cmd,
  struct flock *lock
), {
  l->path = path;
  l->info = info;
  l->cmd = cmd;
  l->lock = lock;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  FUSE_CREATE_FILE_HANDLE_ARGV(3)
  napi_create_int32(env, l->cmd, &(argv[4]));
  napi_create_int32(env, l->lock->l_type, &(argv[5]));
  napi_create_int32(env, l->lock->l_whence, &(argv[6]));
  FUSE_UINT64_TO_INTS_ARGV(l->lock->l_start, 7)
  FUSE_UINT64_TO_INTS_ARGV(l->lock->l_len, 9)
  napi_create_int32(env, l->lock->l_pid, &(argv[11]));
}, {
  uint32_t *encoded = NULL;
  size_t encoded_length = 0;
  if (res == 0 &&
      (get_uint32_array(env, argv[2], &encoded, &encoded_length) != 0 ||
       encoded_length != 7)) {
    res = -EINVAL;
  }
  if (res == 0) {
    int16_t type = (int16_t) encoded[0];
    int16_t whence = (int16_t) encoded[1];
    uint32_t *cursor = &(encoded[2]);
    int64_t start = uint32s_to_int64(&cursor);
    int64_t length = uint32s_to_int64(&cursor);
    int32_t pid = (int32_t) encoded[6];
    off_t native_start;
    off_t native_length;
    if ((uint32_t) (uint16_t) type != encoded[0] ||
        (uint32_t) (uint16_t) whence != encoded[1] ||
        int64_to_off_t(start, &native_start) != 0 ||
        int64_to_off_t(length, &native_length) != 0) {
      res = -ERANGE;
    } else {
      l->lock->l_type = type;
      l->lock->l_whence = whence;
      l->lock->l_start = native_start;
      l->lock->l_len = native_length;
      l->lock->l_pid = (pid_t) pid;
    }
  }
})

FUSE_METHOD(bmap, 3, 1, (
  const char *path,
  size_t blocksize,
  uint64_t *index
), {
  l->path = path;
  l->size = blocksize;
  l->bmap_index = index;
}, {
  napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
  FUSE_CREATE_UINT64_ARGV(l->size, 3)
  FUSE_CREATE_UINT64_ARGV(*(l->bmap_index), 4)
}, {
  uint64_t index = 0;
  if (res == 0 && value_to_uint64(env, argv[2], &index) != 0) res = -EINVAL;
  if (res == 0) *(l->bmap_index) = index;
})

#define FUSE_IOCTL_MAX_SIZE (1024U * 1024U)

static size_t fuse_native_ioctl_size (int cmd) {
#ifdef __APPLE__
  return (size_t) IOCPARM_LEN((uint32_t) cmd);
#else
  return (size_t) _IOC_SIZE((unsigned int) cmd);
#endif
}

static int fuse_native_ioctl_has_input (int cmd) {
#ifdef __APPLE__
  return (((uint32_t) cmd) & IOC_IN) != 0;
#else
  return (_IOC_DIR((unsigned int) cmd) & _IOC_WRITE) != 0;
#endif
}

FUSE_METHOD(ioctl, 6, 1, (
  const char *path,
  int cmd,
  void *arg,
  struct fuse_file_info *info,
  unsigned int flags,
  void *data
), {
  if ((flags & FUSE_IOCTL_UNRESTRICTED) != 0) return -EOPNOTSUPP;
  l->path = path;
  l->cmd = cmd;
  l->info = info;
  l->ioctl_argument = (uintptr_t) arg;
  l->flags = (int) flags;
  l->ioctl_data = data;
  l->size = fuse_native_ioctl_size(cmd);
  if (l->size > FUSE_IOCTL_MAX_SIZE) return -E2BIG;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  FUSE_CREATE_FILE_HANDLE_ARGV(3)
  napi_create_int32(env, l->cmd, &(argv[4]));
  FUSE_CREATE_UINT64_ARGV(l->ioctl_argument, 5)
  napi_create_uint32(env, (uint32_t) l->flags, &(argv[6]));
  FUSE_CREATE_OWNED_BUFFER_ARGV(
    fuse_native_ioctl_has_input(l->cmd) ? l->ioctl_data : NULL,
    l->size,
    7
  )
}, {
  if (res == 0 && l->size > 0) {
    int copy_result = copy_owned_buffer(
      env,
      argv[2],
      l->ioctl_data,
      l->size,
      l->size
    );
    if (copy_result != 0) res = copy_result;
  }
})

FUSE_METHOD(poll, 3, 1, (
  const char *path,
  struct fuse_file_info *info,
  struct fuse_pollhandle *pollhandle,
  unsigned *revents
), {
  l->path = path;
  l->info = info;
  l->pollhandle = pollhandle;
  l->poll_revents = revents;
  if (pollhandle != NULL &&
      (l->fuse->operation_flags & FUSE_OPERATION_FLAG_POLL_HANDLE) != 0) {
    l->poll_registration = fuse_native_register_poll(l->fuse, pollhandle);
    if (l->poll_registration == NULL) {
      fuse_pollhandle_destroy(pollhandle);
      l->pollhandle = NULL;
      return -ENOMEM;
    }
    l->pollhandle = NULL;
  }
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  FUSE_CREATE_FILE_HANDLE_ARGV(3)
  FUSE_CREATE_UINT64_ARGV(
    l->poll_registration == NULL ? 0 : l->poll_registration->id,
    4
  )
}, {
  uint32_t events = 0;
  if (res == 0 && napi_get_value_uint32(env, argv[2], &events) != napi_ok) {
    res = -EINVAL;
  }
  if (res == 0) {
    *(l->poll_revents) = events;
    fuse_native_release_poll_registration(l->poll_registration);
    l->poll_registration = NULL;
  }
})

FUSE_METHOD(write_buf, 6, 0, (
  const char *path,
  struct fuse_bufvec *source,
  off_t offset,
  struct fuse_file_info *info
), {
  l->size = fuse_buf_size(source);
  if (l->size > UINT32_MAX) return -EOVERFLOW;
  l->owned_input = l->size == 0 ? NULL : malloc(l->size);
  if (l->size > 0 && l->owned_input == NULL) return -ENOMEM;
  struct fuse_bufvec destination = FUSE_BUFVEC_INIT(l->size);
  destination.buf[0].mem = l->owned_input;
  ssize_t copied = fuse_buf_copy(&destination, source, FUSE_BUF_NO_SPLICE);
  if (copied < 0 || (size_t) copied != l->size) {
    free(l->owned_input);
    l->owned_input = NULL;
    return copied < 0 ? (int) copied : -EIO;
  }
  l->path = path;
  l->offset = offset;
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  FUSE_CREATE_FILE_HANDLE_ARGV(3)
  FUSE_CREATE_OWNED_BUFFER_ARGV(l->owned_input, l->size, 4)
  napi_create_uint32(env, (uint32_t) l->size, &(argv[5]));
  FUSE_UINT64_TO_INTS_ARGV(l->offset, 6)
}, {})

FUSE_METHOD(read_buf, 5, 1, (
  const char *path,
  struct fuse_bufvec **output,
  size_t size,
  off_t offset,
  struct fuse_file_info *info
), {
  if (size > UINT32_MAX) return -EOVERFLOW;
  l->path = path;
  l->size = size;
  l->offset = offset;
  l->info = info;
  l->bufvec_out = output;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  FUSE_CREATE_FILE_HANDLE_ARGV(3)
  napi_create_uint32(env, (uint32_t) l->size, &(argv[4]));
  FUSE_UINT64_TO_INTS_ARGV(l->offset, 5)
}, {
  bool is_buffer = false;
  void *buffer_data = NULL;
  size_t buffer_size = 0;
  if (res == 0 &&
      (napi_is_buffer(env, argv[2], &is_buffer) != napi_ok ||
       !is_buffer ||
       napi_get_buffer_info(env, argv[2], &buffer_data, &buffer_size) != napi_ok ||
       buffer_size > l->size)) {
    res = -EINVAL;
  }
  if (res == 0) {
    struct fuse_bufvec *output = malloc(sizeof(*output));
    void *output_data = buffer_size == 0 ? NULL : malloc(buffer_size);
    if (output == NULL || (buffer_size > 0 && output_data == NULL)) {
      free(output);
      free(output_data);
      res = -ENOMEM;
    } else {
      *output = FUSE_BUFVEC_INIT(buffer_size);
      output->buf[0].mem = output_data;
      if (buffer_size > 0) memcpy(output_data, buffer_data, buffer_size);
      *(l->bufvec_out) = output;
    }
  }
})

FUSE_METHOD_VOID(flock, 3, 0, (
  const char *path,
  struct fuse_file_info *info,
  int operation
), {
  l->path = path;
  l->info = info;
  l->int_value = operation;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  FUSE_CREATE_FILE_HANDLE_ARGV(3)
  napi_create_int32(env, l->int_value, &(argv[4]));
})

FUSE_METHOD_VOID(fallocate, 7, 0, (
  const char *path,
  int mode,
  off_t offset,
  off_t length,
  struct fuse_file_info *info
), {
  l->path = path;
  l->int_value = mode;
  l->offset = offset;
  l->length = length;
  l->info = info;
}, {
  FUSE_CREATE_PATH_ARGV(l->path, 2)
  FUSE_CREATE_FILE_HANDLE_ARGV(3)
  napi_create_int32(env, l->int_value, &(argv[4]));
  FUSE_UINT64_TO_INTS_ARGV(l->offset, 5)
  FUSE_UINT64_TO_INTS_ARGV(l->length, 7)
})

static void fuse_native_dispatch_copy_file_range (
  uv_async_t *handle,
  fuse_thread_locals_t *l,
  fuse_thread_t *ft
) {
  (void) handle;
  FUSE_NATIVE_CALLBACK(ft->handlers[op_copy_file_range], {
    napi_value argv[13] = {0};
    if (initialize_callback_arguments(env, argv, 13) != napi_ok ||
        napi_get_reference_value(env, l->self, &(argv[0])) != napi_ok ||
        napi_create_uint32(env, l->op, &(argv[1])) != napi_ok) {
      napi_close_handle_scope(env, scope);
      fuse_native_complete_local(l, -EIO);
      return;
    }
    FUSE_CREATE_PATH_ARGV(l->path, 2)
    FUSE_CREATE_UINT64_ARGV(l->info == NULL ? 0 : l->info->fh, 3)
    FUSE_UINT64_TO_INTS_ARGV(l->offset, 4)
    FUSE_CREATE_PATH_ARGV(l->dest, 6)
    FUSE_CREATE_UINT64_ARGV(l->info_out == NULL ? 0 : l->info_out->fh, 7)
    FUSE_UINT64_TO_INTS_ARGV(l->length, 8)
    FUSE_CREATE_UINT64_ARGV(l->size, 10)
    napi_create_int32(env, l->flags, &(argv[11]));
    if (create_request_context_value(env, l, &(argv[12])) != napi_ok) {
      napi_close_handle_scope(env, scope);
      fuse_native_complete_local(l, -EIO);
      return;
    }
    FUSE_CALL_CALLBACK(13, argv)
  })
}

NAPI_METHOD(fuse_native_signal_copy_file_range) {
  NAPI_ARGV(3)
  NAPI_ARGV_BUFFER_CAST(fuse_thread_locals_t *, l, 0);
  NAPI_ARGV_INT32(res, 1);
  int64_t copied = 0;
  if (res == 0 &&
      (value_to_int64_words(env, argv[2], &copied) != 0 ||
       copied < 0 ||
       (uint64_t) copied > (uint64_t) l->size ||
       copied > (int64_t) SSIZE_MAX)) {
    res = -ERANGE;
  }
  if (res == 0) l->signed_result = copied;
  fuse_native_complete_local(l, res);
  return NULL;
}

static ssize_t fuse_native_copy_file_range (
  const char *path_in,
  struct fuse_file_info *info_in,
  off_t offset_in,
  const char *path_out,
  struct fuse_file_info *info_out,
  off_t offset_out,
  size_t size,
  int flags
) {
  fuse_thread_locals_t *l = get_thread_locals();
  if (l == NULL) return -EIO;
  l->info = info_in;
  l->info_out = info_out;
  l->owned_input = NULL;
  l->pollhandle = NULL;
  l->signed_result = 0;
  l->op = op_copy_file_range;
  l->op_fn = fuse_native_dispatch_copy_file_range;
  l->path = path_in;
  l->dest = path_out;
  l->offset = offset_in;
  l->length = offset_out;
  l->size = size;
  l->flags = flags;
  fuse_native_capture_context(l);
  atomic_store(&(l->waiting), 1);
  if (fuse_native_schedule_local(l) < 0) {
    atomic_store(&(l->waiting), 0);
    return -EIO;
  }
  uv_sem_wait(&(l->sem));
  return l->res == 0 ? (ssize_t) l->signed_result : (ssize_t) l->res;
}

static void fuse_native_dispatch_lseek (
  uv_async_t *handle,
  fuse_thread_locals_t *l,
  fuse_thread_t *ft
) {
  (void) handle;
  FUSE_NATIVE_CALLBACK(ft->handlers[op_lseek], {
    napi_value argv[8] = {0};
    if (initialize_callback_arguments(env, argv, 8) != napi_ok ||
        napi_get_reference_value(env, l->self, &(argv[0])) != napi_ok ||
        napi_create_uint32(env, l->op, &(argv[1])) != napi_ok) {
      napi_close_handle_scope(env, scope);
      fuse_native_complete_local(l, -EIO);
      return;
    }
    FUSE_CREATE_PATH_ARGV(l->path, 2)
    FUSE_CREATE_FILE_HANDLE_ARGV(3)
    FUSE_UINT64_TO_INTS_ARGV(l->offset, 4)
    napi_create_int32(env, l->int_value, &(argv[6]));
    if (create_request_context_value(env, l, &(argv[7])) != napi_ok) {
      napi_close_handle_scope(env, scope);
      fuse_native_complete_local(l, -EIO);
      return;
    }
    FUSE_CALL_CALLBACK(8, argv)
  })
}

NAPI_METHOD(fuse_native_signal_lseek) {
  NAPI_ARGV(3)
  NAPI_ARGV_BUFFER_CAST(fuse_thread_locals_t *, l, 0);
  NAPI_ARGV_INT32(res, 1);
  int64_t offset = 0;
  off_t converted = 0;
  if (res == 0 &&
      (value_to_int64_words(env, argv[2], &offset) != 0 ||
       offset < 0 ||
       int64_to_off_t(offset, &converted) != 0)) {
    res = -ERANGE;
  }
  if (res == 0) l->signed_result = offset;
  fuse_native_complete_local(l, res);
  return NULL;
}

static off_t fuse_native_lseek (
  const char *path,
  off_t offset,
  int whence,
  struct fuse_file_info *info
) {
  fuse_thread_locals_t *l = get_thread_locals();
  if (l == NULL) return (off_t) -EIO;
  l->info = info;
  l->info_out = NULL;
  l->owned_input = NULL;
  l->pollhandle = NULL;
  l->signed_result = 0;
  l->op = op_lseek;
  l->op_fn = fuse_native_dispatch_lseek;
  l->path = path;
  l->offset = offset;
  l->int_value = whence;
  fuse_native_capture_context(l);
  atomic_store(&(l->waiting), 1);
  if (fuse_native_schedule_local(l) < 0) {
    atomic_store(&(l->waiting), 0);
    return (off_t) -EIO;
  }
  uv_sem_wait(&(l->sem));
  return l->res == 0 ? (off_t) l->signed_result : (off_t) l->res;
}

#if defined(__linux__) && FUSE_VERSION >= FUSE_MAKE_VERSION(3, 18)
static int fuse_native_statx (
  const char *path,
  int flags,
  int mask,
  struct statx *statx,
  struct fuse_file_info *info
) {
  (void) flags;
  (void) mask;
  struct stat stat = {0};
  int result = fuse_native_getattr_v3(path, &stat, info);
  if (result != 0) return result;
  if ((uint64_t) stat.st_blksize > UINT32_MAX ||
      (uint64_t) stat.st_mode > UINT16_MAX) {
    return -EOVERFLOW;
  }

  memset(statx, 0, sizeof(*statx));
  statx->stx_mask = STATX_BASIC_STATS;
  statx->stx_blksize = (uint32_t) stat.st_blksize;
  statx->stx_nlink = (uint32_t) stat.st_nlink;
  statx->stx_uid = stat.st_uid;
  statx->stx_gid = stat.st_gid;
  statx->stx_mode = (uint16_t) stat.st_mode;
  statx->stx_ino = stat.st_ino;
  statx->stx_size = (uint64_t) stat.st_size;
  statx->stx_blocks = (uint64_t) stat.st_blocks;
  statx->stx_atime.tv_sec = stat.st_atim.tv_sec;
  statx->stx_atime.tv_nsec = (uint32_t) stat.st_atim.tv_nsec;
  statx->stx_mtime.tv_sec = stat.st_mtim.tv_sec;
  statx->stx_mtime.tv_nsec = (uint32_t) stat.st_mtim.tv_nsec;
  statx->stx_ctime.tv_sec = stat.st_ctim.tv_sec;
  statx->stx_ctime.tv_nsec = (uint32_t) stat.st_ctim.tv_nsec;
  statx->stx_rdev_major = major(stat.st_rdev);
  statx->stx_rdev_minor = minor(stat.st_rdev);
  statx->stx_dev_major = major(stat.st_dev);
  statx->stx_dev_minor = minor(stat.st_dev);
  return 0;
}
#endif

#define FUSE_INIT_CONFIG_MAX_WRITE 1U
#define FUSE_INIT_CONFIG_MAX_READAHEAD 2U
#define FUSE_INIT_CONFIG_MAX_BACKGROUND 4U
#define FUSE_INIT_CONFIG_CONGESTION_THRESHOLD 8U
#define FUSE_INIT_CONFIG_WANT 16U
#define FUSE_INIT_CONFIG_ASYNC_READ 32U
#define FUSE_INIT_CONFIG_MAX_BACKING_STACK_DEPTH 64U
#define FUSE_INIT_CONFIG_ALLOWED_MASK \
  (FUSE_INIT_CONFIG_MAX_WRITE | FUSE_INIT_CONFIG_MAX_READAHEAD | \
   FUSE_INIT_CONFIG_MAX_BACKGROUND | FUSE_INIT_CONFIG_CONGESTION_THRESHOLD | \
   FUSE_INIT_CONFIG_WANT | FUSE_INIT_CONFIG_ASYNC_READ | \
   FUSE_INIT_CONFIG_MAX_BACKING_STACK_DEPTH)

static void fuse_native_dispatch_init (uv_async_t* handle, fuse_thread_locals_t* l, fuse_thread_t* ft) {
  (void) handle;
  FUSE_NATIVE_CALLBACK(ft->handlers[op_init], {
    napi_value argv[13] = {0};

    if (l->conn == NULL ||
        napi_get_reference_value(env, l->self, &(argv[0])) != napi_ok ||
        napi_create_uint32(env, l->op, &(argv[1])) != napi_ok ||
        napi_create_uint32(env, l->conn->proto_major, &(argv[2])) != napi_ok ||
        napi_create_uint32(env, l->conn->proto_minor, &(argv[3])) != napi_ok ||
        napi_create_uint32(
          env,
          (l->conn->want & FUSE_CAP_ASYNC_READ) != 0,
          &(argv[4])
        ) != napi_ok ||
        napi_create_uint32(env, l->conn->max_write, &(argv[5])) != napi_ok ||
        napi_create_uint32(env, l->conn->max_readahead, &(argv[6])) != napi_ok ||
        napi_create_uint32(env, l->conn->capable, &(argv[7])) != napi_ok ||
        napi_create_uint32(env, l->conn->want, &(argv[8])) != napi_ok ||
        napi_create_uint32(env, l->conn->max_background, &(argv[9])) != napi_ok ||
        napi_create_uint32(env, l->conn->congestion_threshold, &(argv[10])) != napi_ok ||
        napi_create_uint32(env, l->conn->max_read, &(argv[11])) != napi_ok ||
        create_request_context_value(env, l, &(argv[12])) != napi_ok) {
      napi_close_handle_scope(env, scope);
      fuse_native_complete_local(l, -EIO);
      return;
    }

    FUSE_CALL_CALLBACK(13, argv)
  })
}

NAPI_METHOD(fuse_native_signal_init) {
  NAPI_ARGV(3)
  NAPI_ARGV_BUFFER_CAST(fuse_thread_locals_t *, l, 0);
  NAPI_ARGV_INT32(res, 1);
  uint32_t *config = NULL;
  size_t config_length = 0;

  if (res == 0 &&
      (l->conn == NULL ||
       get_uint32_array(env, argv[2], &config, &config_length) != 0 ||
       config_length != 8 ||
       (config[0] & ~FUSE_INIT_CONFIG_ALLOWED_MASK) != 0)) {
    res = -EINVAL;
  }

  if (res == 0) {
    const uint32_t mask = config[0];
    const uint32_t max_write = (mask & FUSE_INIT_CONFIG_MAX_WRITE) != 0
      ? config[1]
      : l->conn->max_write;
    const uint32_t max_readahead = (mask & FUSE_INIT_CONFIG_MAX_READAHEAD) != 0
      ? config[2]
      : l->conn->max_readahead;
    const uint32_t max_background = (mask & FUSE_INIT_CONFIG_MAX_BACKGROUND) != 0
      ? config[3]
      : l->conn->max_background;
    const uint32_t congestion_threshold = (mask & FUSE_INIT_CONFIG_CONGESTION_THRESHOLD) != 0
      ? config[4]
      : l->conn->congestion_threshold;
    uint32_t want = (mask & FUSE_INIT_CONFIG_WANT) != 0
      ? config[5]
      : l->conn->want;
    const uint32_t async_read = (mask & FUSE_INIT_CONFIG_ASYNC_READ) != 0
      ? config[6]
      : (l->conn->want & FUSE_CAP_ASYNC_READ) != 0;

    if ((mask & FUSE_INIT_CONFIG_ASYNC_READ) != 0) {
      if (async_read != 0) {
        want |= FUSE_CAP_ASYNC_READ;
      } else {
        want &= ~((uint32_t) FUSE_CAP_ASYNC_READ);
      }
    }

    if (((mask & FUSE_INIT_CONFIG_MAX_WRITE) != 0 &&
         (max_write == 0 || max_write > l->conn->max_write)) ||
        ((mask & FUSE_INIT_CONFIG_MAX_READAHEAD) != 0 &&
         max_readahead > l->conn->max_readahead) ||
        ((mask & FUSE_INIT_CONFIG_MAX_BACKGROUND) != 0 &&
         (max_background == 0 || max_background > l->conn->max_background)) ||
        ((mask & FUSE_INIT_CONFIG_CONGESTION_THRESHOLD) != 0 &&
         (congestion_threshold == 0 ||
          congestion_threshold > l->conn->congestion_threshold)) ||
        ((mask & (FUSE_INIT_CONFIG_MAX_BACKGROUND |
                  FUSE_INIT_CONFIG_CONGESTION_THRESHOLD)) != 0 &&
         congestion_threshold > max_background) ||
        ((mask & (FUSE_INIT_CONFIG_WANT | FUSE_INIT_CONFIG_ASYNC_READ)) != 0 &&
         (want & ~l->conn->capable) != 0) ||
        ((mask & FUSE_INIT_CONFIG_ASYNC_READ) != 0 && async_read > 1U)) {
      res = -EINVAL;
    } else {
      if ((mask & FUSE_INIT_CONFIG_MAX_WRITE) != 0) l->conn->max_write = max_write;
      if ((mask & FUSE_INIT_CONFIG_MAX_READAHEAD) != 0) l->conn->max_readahead = max_readahead;
      if ((mask & FUSE_INIT_CONFIG_MAX_BACKGROUND) != 0) l->conn->max_background = max_background;
      if ((mask & FUSE_INIT_CONFIG_CONGESTION_THRESHOLD) != 0) {
        l->conn->congestion_threshold = congestion_threshold;
      }
#if FUSE_HAS_BACKING_ID
      /* Required before the kernel will accept a backing file whose
       * underlying fs is itself stacked (overlayfs). Harmless otherwise. */
      if ((mask & FUSE_INIT_CONFIG_MAX_BACKING_STACK_DEPTH) != 0) {
        l->conn->max_backing_stack_depth = config[7];
      }
#endif
      if ((mask & (FUSE_INIT_CONFIG_WANT | FUSE_INIT_CONFIG_ASYNC_READ)) != 0) {
        l->conn->want = want;
      }
    }
  }

  fuse_native_complete_local(l, res);
  return NULL;
}

static void * fuse_native_init (
  struct fuse_conn_info *conn,
  struct fuse_config *config
) {
  fuse_thread_locals_t *l = get_thread_locals();
  struct fuse_context *context = fuse_get_context();
  fuse_thread_t *ft = context == NULL
    ? NULL
    : (fuse_thread_t *) context->private_data;
  if (ft == NULL) return NULL;

  /*
   * libfuse requires max_read from fuse_new() and the init hook to match.
   * Preserve its normal negotiation completely when the option was omitted.
   */
  if (ft->max_read_configured) conn->max_read = ft->configured_max_read;

  /*
   * FUSE 3 moved the old operation-level null-path flags into fuse_config.
   * Either legacy flag means the JavaScript implementation accepts a NULL
   * path for handle-based operations.
   */
  if (config != NULL) {
    config->nullpath_ok =
      (ft->operation_flags &
       (FUSE_OPERATION_FLAG_NULL_PATH_OK | FUSE_OPERATION_FLAG_NO_PATH)) != 0;
    config->direct_io =
      (ft->operation_flags & FUSE_OPERATION_FLAG_DIRECT_IO) != 0;
  }

  if (!ft->implemented[op_init] || l == NULL) return ft;

  l->op = op_init;
  l->op_fn = fuse_native_dispatch_init;
  l->conn = conn;
  l->config = config;
  l->info = NULL;
  fuse_native_capture_context(l);

  atomic_store(&(l->waiting), 1);
  if (fuse_native_schedule_local(l) < 0) {
    atomic_store(&(l->waiting), 0);
    return ft;
  }
  uv_sem_wait(&(l->sem));
  l->conn = NULL;
  l->config = NULL;

  return ft;
}

// Top-level dispatcher

static int fuse_native_schedule_local (fuse_thread_locals_t *l) {
  fuse_thread_t *ft = l->fuse;
  if (!l->async_initialized ||
      (atomic_load(&(ft->cleanup_requested)) && l->op != op_destroy)) {
    return UV_ECANCELED;
  }
  return uv_async_send(&(l->async));
}

static void fuse_native_dispatch (uv_async_t* handle) {
  fuse_thread_locals_t *l = (fuse_thread_locals_t *) handle->data;
  fuse_thread_t *ft = l->fuse;
  if (atomic_load(&(l->waiting)) == 0) return;
  if (atomic_load(&(ft->cleanup_requested)) && l->op != op_destroy) {
    fuse_native_complete_local(l, -EIO);
    return;
  }
  l->op_fn(handle, l, ft);
}

static int fuse_native_create_worker_locals (fuse_thread_t *ft) {
  /*
   * N-API values and libuv handles must be created on the JavaScript thread.
   * Each worker gets a dedicated async handle, so one worker can have at most
   * one outstanding notification and libuv coalescing cannot lose ownership
   * of a different worker's request.
   */
  for (size_t i = 0; i < ft->max_workers; i++) {
    fuse_thread_locals_t *l = calloc(1, sizeof(*l));
    if (l == NULL) return UV_ENOMEM;

    napi_handle_scope scope;
    if (napi_open_handle_scope(ft->env, &scope) != napi_ok) {
      free(l);
      return UV_EIO;
    }

    l->fuse = ft;
    atomic_init(&(l->waiting), 0);

    napi_value buf;
    if (napi_create_external_buffer(
          ft->env,
          sizeof(*l),
          (char *) l,
          NULL,
          NULL,
          &buf
        ) != napi_ok ||
        napi_create_reference(ft->env, buf, 1, &(l->self)) != napi_ok) {
      free(l);
      napi_close_handle_scope(ft->env, scope);
      return UV_EIO;
    }

    int err = uv_sem_init(&(l->sem), 0);
    if (err < 0) {
      napi_delete_reference(ft->env, l->self);
      free(l);
      napi_close_handle_scope(ft->env, scope);
      return err;
    }
    l->sem_initialized = 1;

    err = uv_async_init(ft->loop, &(l->async), (uv_async_cb) fuse_native_dispatch);
    if (err < 0) {
      uv_sem_destroy(&(l->sem));
      l->sem_initialized = 0;
      napi_delete_reference(ft->env, l->self);
      l->self = NULL;
      free(l);
      napi_close_handle_scope(ft->env, scope);
      return err;
    }
    l->async_initialized = 1;
    l->async.data = l;
    uv_unref((uv_handle_t *) &(l->async));

    l->next = ft->locals;
    ft->locals = l;
    napi_close_handle_scope(ft->env, scope);
  }
  return 0;
}

static fuse_thread_locals_t* get_thread_locals (void) {
  struct fuse_context *ctx = fuse_get_context();
  if (ctx == NULL || ctx->private_data == NULL) return NULL;
  fuse_thread_t *ft = (fuse_thread_t *) ctx->private_data;
  if (atomic_load(&(ft->cleanup_requested))) return NULL;
  return (fuse_thread_locals_t *) pthread_getspecific(thread_locals_key);
}

static void fuse_native_record_loop_error (fuse_thread_t *ft, int error) {
  int expected = 0;
  atomic_compare_exchange_strong(&(ft->loop_result), &expected, error);
}

static void fuse_native_worker_finished (void *data) {
  fuse_worker_t *worker = (fuse_worker_t *) data;
  uv_sem_post(&(worker->fuse->workers_finished));
}

static void fuse_native_release_worker_buffer (fuse_worker_t *worker) {
#ifdef __APPLE__
  if (worker->fuse->buf_free != NULL) {
    worker->fuse->buf_free(&(worker->buffer));
  }
#else
  free(worker->buffer.mem);
#endif
  memset(&(worker->buffer), 0, sizeof(worker->buffer));
}

static void* fuse_native_worker (void *data) {
  fuse_worker_t *worker = (fuse_worker_t *) data;
  fuse_thread_t *ft = worker->fuse;
  struct fuse_session *session = fuse_get_session(ft->fuse);

  (void) pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, NULL);
  pthread_cleanup_push(fuse_native_worker_finished, worker);
  int locals_result = pthread_setspecific(
    thread_locals_key,
    (void *) worker->locals
  );
  if (locals_result != 0) {
    fuse_native_record_loop_error(ft, -locals_result);
    fuse_session_exit(session);
  } else {
    while (!fuse_session_exited(session)) {
      (void) pthread_setcancelstate(PTHREAD_CANCEL_ENABLE, NULL);
      int result = fuse_session_receive_buf(session, &(worker->buffer));
      (void) pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, NULL);
      if (result == -EINTR) continue;
      if (result <= 0) {
        if (result < 0) {
          fuse_native_record_loop_error(ft, result);
          fuse_session_exit(session);
        }
        break;
      }
      fuse_session_process_buf(session, &(worker->buffer));
    }
  }
  pthread_cleanup_pop(1);
  return NULL;
}

static void fuse_native_cancel_workers_locked (fuse_thread_t *ft) {
  for (size_t i = 0; i < ft->workers_started; i++) {
    (void) pthread_cancel(ft->workers[i].thread);
  }
}

static void fuse_native_dispose_mount (
  struct fuse *fuse,
  int mounted
) {
  if (mounted && fuse != NULL) fuse_unmount(fuse);
  if (fuse != NULL) fuse_destroy(fuse);
}

static void* start_fuse_thread (void *data) {
  fuse_thread_t *ft = (fuse_thread_t *) data;
  struct fuse_session *session = fuse_get_session(ft->fuse);
  fuse_worker_t *workers = calloc(ft->max_workers, sizeof(*workers));
  size_t workers_to_join = 0;

  if (session == NULL) {
    fuse_native_record_loop_error(ft, -EIO);
  } else if (workers == NULL) {
    fuse_native_record_loop_error(ft, -ENOMEM);
  } else {
    if (fuse_start_cleanup_thread(ft->fuse) != 0) {
      fuse_native_record_loop_error(ft, -EIO);
      fuse_session_exit(session);
    } else {
      ft->fuse_cache_cleanup_started = 1;
    }

    uv_mutex_lock(&(ft->mut));
    ft->workers = workers;
    uv_mutex_unlock(&(ft->mut));

    fuse_thread_locals_t *locals = ft->locals;
    for (size_t i = 0;
         atomic_load(&(ft->loop_result)) == 0 &&
           !atomic_load(&(ft->cleanup_requested)) &&
           i < ft->max_workers;
         i++) {
      if (locals == NULL) {
        fuse_native_record_loop_error(ft, -EIO);
        break;
      }
      workers[i].fuse = ft;
      workers[i].locals = locals;

      int result = pthread_create(
        &(workers[i].thread),
        &(ft->attr),
        fuse_native_worker,
        &(workers[i])
      );
      if (result != 0) {
        fuse_native_record_loop_error(ft, -result);
        break;
      }
      uv_mutex_lock(&(ft->mut));
      ft->workers_started++;
      uv_mutex_unlock(&(ft->mut));
      locals = locals->next;
    }

    if (ft->workers_started != ft->max_workers ||
        atomic_load(&(ft->cleanup_requested))) {
      if (atomic_load(&(ft->loop_result)) == 0) {
        fuse_native_record_loop_error(ft, -EIO);
      }
      fuse_session_exit(session);
    } else {
      uv_sem_wait(&(ft->workers_finished));
    }

    fuse_session_exit(session);
    uv_mutex_lock(&(ft->mut));
    workers_to_join = ft->workers_started;
    fuse_native_cancel_workers_locked(ft);
    /*
     * Cleanup uses the same mutex before cancelling workers. Retire the
     * published set before joining it so another cleanup path can never call
     * pthread_cancel() with a pthread_t that has already been joined.
     */
    ft->workers = NULL;
    ft->workers_started = 0;
    uv_mutex_unlock(&(ft->mut));

    for (size_t i = 0; i < workers_to_join; i++) {
      int result = pthread_join(workers[i].thread, NULL);
      if (result != 0) fuse_native_record_loop_error(ft, -result);
      fuse_native_release_worker_buffer(&(workers[i]));
    }
    fuse_session_reset(session);
  }

  if (ft->fuse_cache_cleanup_started) {
    fuse_stop_cleanup_thread(ft->fuse);
    ft->fuse_cache_cleanup_started = 0;
  }

  fuse_native_close_all_polls(ft);
  if (ft->invalidation_mutex_initialized && ft->invalidation_cond_initialized) {
    uv_mutex_lock(&(ft->invalidation_mut));
    ft->invalidation_stopping = 1;
    while (ft->invalidation_active) {
      uv_cond_wait(&(ft->invalidation_cond), &(ft->invalidation_mut));
    }
  }
  uv_mutex_lock(&(ft->mut));
  struct fuse *fuse = ft->fuse;
  int mounted = ft->fuse_mounted;
  ft->fuse = NULL;
  ft->fuse_mounted = 0;
  uv_mutex_unlock(&(ft->mut));
  if (ft->invalidation_mutex_initialized && ft->invalidation_cond_initialized) {
    uv_mutex_unlock(&(ft->invalidation_mut));
  }
  free(workers);

  fuse_native_dispose_mount(fuse, mounted);

  if (!atomic_load(&(ft->cleanup_requested))) {
    int result = uv_async_send(&(ft->loop_exit_async));
    if (result < 0) fuse_native_record_loop_error(ft, result);
  }

  return NULL;
}

static void fuse_native_delete_references (fuse_thread_t *ft) {
  if (ft->ctx != NULL) {
    napi_delete_reference(ft->env, ft->ctx);
    ft->ctx = NULL;
  }
  if (ft->loop_exit_cb != NULL) {
    napi_delete_reference(ft->env, ft->loop_exit_cb);
    ft->loop_exit_cb = NULL;
  }
  for (size_t i = 0; i < FUSE_OPERATION_COUNT; i++) {
    if (ft->handlers[i] != NULL) {
      napi_delete_reference(ft->env, ft->handlers[i]);
      ft->handlers[i] = NULL;
    }
  }
}

static void fuse_native_free_strings (fuse_thread_t *ft) {
  free(ft->mnt);
  free(ft->mntopts);
  ft->mnt = NULL;
  ft->mntopts = NULL;
}

static void fuse_native_mount_cleanup_finished (fuse_thread_t *ft) {
  ft->mount_cleanup_pending = 0;
  if (ft->cleanup_hook != NULL) {
    napi_remove_async_cleanup_hook(ft->cleanup_hook);
    ft->cleanup_hook = NULL;
  }
  if (ft->state_ref != NULL) {
    napi_delete_reference(ft->env, ft->state_ref);
    ft->state_ref = NULL;
  }
}

static void fuse_native_mount_close_complete (fuse_thread_t *ft) {
  if (ft->close_pending == 0) return;
  ft->close_pending--;
  if (ft->close_pending == 0) fuse_native_mount_cleanup_finished(ft);
}

static void fuse_native_mount_thread_async_closed (uv_handle_t *handle) {
  fuse_thread_t *ft = (fuse_thread_t *) handle->data;
  fuse_native_mount_close_complete(ft);
}

static void fuse_native_mount_local_closed (uv_handle_t *handle) {
  fuse_thread_locals_t *l = (fuse_thread_locals_t *) handle->data;
  fuse_thread_t *ft = l->fuse;
  free(l);
  fuse_native_mount_close_complete(ft);
}

static void fuse_native_loop_exit_dispatch (uv_async_t *handle) {
  fuse_thread_t *ft = (fuse_thread_t *) handle->data;
  if (atomic_load(&(ft->cleanup_requested)) || ft->loop_exit_cb == NULL) return;

  napi_handle_scope scope;
  if (napi_open_handle_scope(ft->env, &scope) != napi_ok) return;
  napi_value callback;
  napi_value receiver;
  napi_value result;
  if (napi_get_reference_value(ft->env, ft->loop_exit_cb, &callback) == napi_ok &&
      napi_get_reference_value(ft->env, ft->ctx, &receiver) == napi_ok &&
      napi_create_int32(ft->env, atomic_load(&(ft->loop_result)), &result) == napi_ok) {
    napi_status status = napi_make_callback(
      ft->env,
      NULL,
      receiver,
      callback,
      1,
      &result,
      NULL
    );
    if (status == napi_pending_exception) {
      napi_value exception;
      if (napi_get_and_clear_last_exception(ft->env, &exception) == napi_ok) {
        napi_fatal_exception(ft->env, exception);
      }
    }
  }
  napi_close_handle_scope(ft->env, scope);
}

static void fuse_native_mount_cleanup (fuse_thread_t *ft) {
  ft->mount_cleanup_pending = 1;
  fuse_native_close_all_polls(ft);
  if (ft->fuse != NULL) {
    fuse_native_dispose_mount(ft->fuse, ft->fuse_mounted);
    ft->fuse = NULL;
    ft->fuse_mounted = 0;
  }

  /*
   * ft is backed by a JavaScript Buffer and contains loop_exit_async inline.
   * Worker locals contain their own async handles. Keep state_ref alive until
   * every close callback has run so none of that storage can be reclaimed
   * while libuv still owns a handle.
   */
  ft->close_pending = 0;
  for (fuse_thread_locals_t *l = ft->locals; l != NULL; l = l->next) {
    if (l->async_initialized) ft->close_pending++;
  }
  if (ft->loop_exit_async_initialized) ft->close_pending++;

  fuse_thread_locals_t *l = ft->locals;
  ft->locals = NULL;
  while (l != NULL) {
    fuse_thread_locals_t *next = l->next;
    if (l->self != NULL) {
      napi_delete_reference(ft->env, l->self);
      l->self = NULL;
    }
    if (l->sem_initialized) {
      uv_sem_destroy(&(l->sem));
      l->sem_initialized = 0;
    }
    if (l->async_initialized) {
      l->async_initialized = 0;
      l->async.data = l;
      uv_close((uv_handle_t *) &(l->async), fuse_native_mount_local_closed);
    } else {
      free(l);
    }
    l = next;
  }

  if (ft->loop_exit_async_initialized) {
    ft->loop_exit_async.data = ft;
    uv_close(
      (uv_handle_t *) &(ft->loop_exit_async),
      fuse_native_mount_thread_async_closed
    );
    ft->loop_exit_async_initialized = 0;
  }
  if (ft->workers_sem_initialized) {
    uv_sem_destroy(&(ft->workers_finished));
    ft->workers_sem_initialized = 0;
  }
  if (ft->invalidation_cond_initialized) {
    uv_cond_destroy(&(ft->invalidation_cond));
    ft->invalidation_cond_initialized = 0;
  }
  if (ft->invalidation_mutex_initialized) {
    uv_mutex_destroy(&(ft->invalidation_mut));
    ft->invalidation_mutex_initialized = 0;
  }
  if (ft->mutex_initialized) {
    uv_mutex_destroy(&(ft->mut));
    ft->mutex_initialized = 0;
  }
  if (ft->attr_initialized) {
    pthread_attr_destroy(&(ft->attr));
    ft->attr_initialized = 0;
  }
  if (ft->mount_cb != NULL) {
    napi_delete_reference(ft->env, ft->mount_cb);
    ft->mount_cb = NULL;
  }
  fuse_native_delete_references(ft);
  fuse_native_free_strings(ft);
  if (ft->close_pending == 0) fuse_native_mount_cleanup_finished(ft);
}

NAPI_METHOD(fuse_native_cancel_mount) {
  NAPI_ARGV(1)
  NAPI_ARGV_BUFFER_CAST(fuse_thread_t *, ft, 0);
  if (ft_len < sizeof(*ft) || !ft->mount_pending) {
    napi_throw_error(env, "EINVAL", "FUSE mount is not pending");
    return NULL;
  }
  atomic_store(&(ft->mount_cancelled), 1);
  (void) uv_cancel((uv_req_t *) &(ft->mount_work));
  return NULL;
}

static char * fuse_native_string (napi_env env, napi_value value) {
  size_t size = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &size) != napi_ok) return NULL;
  char *string = malloc(size + 1);
  if (string == NULL) return NULL;
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, string, size + 1, &written) != napi_ok) {
    free(string);
    return NULL;
  }
  string[written] = '\0';
  return string;
}

static void fuse_native_finish_cleanup (fuse_thread_t *ft);

static napi_value fuse_native_cleanup_error_value (
  fuse_thread_t *ft,
  bool cleanup_complete
) {
  napi_value code;
  napi_value message;
  napi_value error;
  napi_value complete;
  char text[128];
  snprintf(text, sizeof(text), "Native FUSE cleanup failed: %s", strerror(ft->cleanup_error));
  napi_create_string_utf8(ft->env, "EFUSECLEANUP", NAPI_AUTO_LENGTH, &code);
  napi_create_string_utf8(ft->env, text, NAPI_AUTO_LENGTH, &message);
  napi_create_error(ft->env, code, message, &error);
  napi_get_boolean(ft->env, cleanup_complete, &complete);
  napi_set_named_property(ft->env, error, "cleanupComplete", complete);
  return error;
}

static void fuse_native_report_cleanup_failure (fuse_thread_t *ft) {
  if (ft->env_cleanup) {
    napi_fatal_error(
      "fuse-napi",
      NAPI_AUTO_LENGTH,
      "A native FUSE thread could not be joined during environment cleanup",
      NAPI_AUTO_LENGTH
    );
    return;
  }

  atomic_store(&(ft->cleanup_scheduled), 0);
  if (ft->cleanup_cb == NULL) return;

  napi_handle_scope scope;
  if (napi_open_handle_scope(ft->env, &scope) != napi_ok) {
    napi_fatal_error(
      "fuse-napi",
      NAPI_AUTO_LENGTH,
      "Failed to report an incomplete native FUSE cleanup",
      NAPI_AUTO_LENGTH
    );
    return;
  }
  napi_value callback;
  napi_value global;
  napi_value error = fuse_native_cleanup_error_value(ft, false);
  napi_get_global(ft->env, &global);
  napi_get_reference_value(ft->env, ft->cleanup_cb, &callback);
  napi_delete_reference(ft->env, ft->cleanup_cb);
  ft->cleanup_cb = NULL;
  napi_status call_status = napi_call_function(
    ft->env,
    global,
    callback,
    1,
    &error,
    NULL
  );
  if (call_status == napi_pending_exception) {
    napi_value exception;
    if (napi_get_and_clear_last_exception(ft->env, &exception) == napi_ok) {
      napi_fatal_exception(ft->env, exception);
    }
  }
  napi_close_handle_scope(ft->env, scope);
}

static void fuse_native_thread_async_closed (uv_handle_t *handle) {
  fuse_thread_t *ft = (fuse_thread_t *) handle->data;
  if (--ft->close_pending == 0) fuse_native_finish_cleanup(ft);
}

static void fuse_native_local_closed (uv_handle_t *handle) {
  fuse_thread_locals_t *l = (fuse_thread_locals_t *) handle->data;
  fuse_thread_t *ft = l->fuse;
  free(l);
  if (--ft->close_pending == 0) fuse_native_finish_cleanup(ft);
}

static void fuse_native_finish_cleanup (fuse_thread_t *ft) {
  ft->mounted = 0;
  ft->thread_started = 0;
  ft->locals = NULL;
  fuse_native_free_strings(ft);

  if (ft->cleanup_hook != NULL) {
    napi_remove_async_cleanup_hook(ft->cleanup_hook);
    ft->cleanup_hook = NULL;
  }

  if (ft->env_cleanup) {
    if (ft->cleanup_cb != NULL) {
      napi_delete_reference(ft->env, ft->cleanup_cb);
      ft->cleanup_cb = NULL;
    }
    if (ft->state_ref != NULL) {
      napi_delete_reference(ft->env, ft->state_ref);
      ft->state_ref = NULL;
    }
    return;
  }

  napi_handle_scope scope;
  if (napi_open_handle_scope(ft->env, &scope) != napi_ok) {
    if (ft->cleanup_cb != NULL) {
      napi_delete_reference(ft->env, ft->cleanup_cb);
      ft->cleanup_cb = NULL;
    }
    if (ft->state_ref != NULL) {
      napi_delete_reference(ft->env, ft->state_ref);
      ft->state_ref = NULL;
    }
    return;
  }
  napi_value callback;
  napi_value global;
  napi_value argv[1];
  napi_get_global(ft->env, &global);
  napi_get_reference_value(ft->env, ft->cleanup_cb, &callback);

  if (ft->cleanup_error == 0) {
    napi_get_null(ft->env, &(argv[0]));
  } else {
    argv[0] = fuse_native_cleanup_error_value(ft, true);
  }

  napi_delete_reference(ft->env, ft->cleanup_cb);
  ft->cleanup_cb = NULL;
  napi_status call_status = napi_call_function(ft->env, global, callback, 1, argv, NULL);
  if (call_status == napi_pending_exception) {
    napi_value exception;
    napi_get_and_clear_last_exception(ft->env, &exception);
    napi_fatal_exception(ft->env, exception);
  }
  napi_close_handle_scope(ft->env, scope);
  if (ft->state_ref != NULL) {
    napi_delete_reference(ft->env, ft->state_ref);
    ft->state_ref = NULL;
  }
}

static void fuse_native_cleanup_work (uv_work_t *request) {
  fuse_thread_t *ft = (fuse_thread_t *) request->data;

  if (ft->invalidation_mutex_initialized && ft->invalidation_cond_initialized) {
    uv_mutex_lock(&(ft->invalidation_mut));
    ft->invalidation_stopping = 1;
    while (ft->invalidation_active) {
      uv_cond_wait(&(ft->invalidation_cond), &(ft->invalidation_mut));
    }
    uv_mutex_unlock(&(ft->invalidation_mut));
  }

  if (ft->mutex_initialized) {
    uv_mutex_lock(&(ft->mut));
    if (ft->fuse != NULL) fuse_exit(ft->fuse);
    if (ft->workers != NULL) fuse_native_cancel_workers_locked(ft);
    uv_mutex_unlock(&(ft->mut));
  }

  ft->cleanup_invalidation_thread_joined = !ft->invalidation_thread_started;
  if (ft->invalidation_thread_started) {
    int err = pthread_join(ft->invalidation_thread, NULL);
    if (err != 0) {
      ft->cleanup_error = err;
      return;
    }
    ft->cleanup_invalidation_thread_joined = 1;
    ft->invalidation_thread_started = 0;
  }

  ft->cleanup_thread_joined = !ft->thread_started;
  if (ft->thread_started) {
    int err = pthread_join(ft->thread, NULL);
    if (err != 0) {
      ft->cleanup_error = err;
      return;
    }
    ft->cleanup_thread_joined = 1;
  }

  for (fuse_thread_locals_t *l = ft->locals; l != NULL; l = l->next) {
    if (l->sem_initialized) {
      uv_sem_destroy(&(l->sem));
      l->sem_initialized = 0;
    }
  }
  if (ft->workers_sem_initialized) {
    uv_sem_destroy(&(ft->workers_finished));
    ft->workers_sem_initialized = 0;
  }
  if (ft->attr_initialized) {
    int err = pthread_attr_destroy(&(ft->attr));
    if (err != 0 && ft->cleanup_error == 0) ft->cleanup_error = err;
    ft->attr_initialized = 0;
  }
  if (ft->invalidation_cond_initialized) {
    uv_cond_destroy(&(ft->invalidation_cond));
    ft->invalidation_cond_initialized = 0;
  }
  if (ft->invalidation_mutex_initialized) {
    uv_mutex_destroy(&(ft->invalidation_mut));
    ft->invalidation_mutex_initialized = 0;
  }
  if (ft->mutex_initialized) {
    uv_mutex_destroy(&(ft->mut));
    ft->mutex_initialized = 0;
  }
}

static void fuse_native_cleanup_after (uv_work_t *request, int status) {
  fuse_thread_t *ft = (fuse_thread_t *) request->data;
  if (status < 0) {
    if (ft->cleanup_error == 0) ft->cleanup_error = EIO;
    ft->cleanup_thread_joined = 0;
    ft->cleanup_invalidation_thread_joined = 0;
  }
  if (!ft->cleanup_thread_joined || !ft->cleanup_invalidation_thread_joined) {
    fuse_native_report_cleanup_failure(ft);
    return;
  }

  fuse_native_delete_references(ft);
  ft->close_pending = 0;

  for (fuse_thread_locals_t *l = ft->locals; l != NULL; l = l->next) {
    if (l->self != NULL) {
      napi_delete_reference(ft->env, l->self);
      l->self = NULL;
    }
    if (l->async_initialized) ft->close_pending++;
  }
  if (ft->loop_exit_async_initialized) ft->close_pending++;

  for (fuse_thread_locals_t *l = ft->locals; l != NULL; l = l->next) {
    if (l->async_initialized) {
      l->async_initialized = 0;
      l->async.data = l;
      uv_close((uv_handle_t *) &(l->async), fuse_native_local_closed);
    }
  }
  if (ft->loop_exit_async_initialized) {
    ft->loop_exit_async_initialized = 0;
    ft->loop_exit_async.data = ft;
    uv_close((uv_handle_t *) &(ft->loop_exit_async), fuse_native_thread_async_closed);
  }

  if (ft->close_pending == 0) fuse_native_finish_cleanup(ft);
}

static int fuse_native_begin_cleanup (fuse_thread_t *ft, int env_cleanup) {
  int expected = 0;
  if (!atomic_compare_exchange_strong(&(ft->cleanup_scheduled), &expected, 1)) return UV_EALREADY;
  atomic_store(&(ft->cleanup_requested), 1);
  ft->env_cleanup = env_cleanup;
  ft->cleanup_error = 0;
  ft->cleanup_thread_joined = 0;
  ft->cleanup_invalidation_thread_joined = 0;

  for (fuse_thread_locals_t *l = ft->locals; l != NULL; l = l->next) {
    if (l->op != op_destroy && l->op != op_poll) {
      fuse_native_complete_local(l, -EIO);
    }
  }
  for (fuse_thread_locals_t *l = ft->locals; l != NULL; l = l->next) {
    if (l->op == op_poll) fuse_native_complete_local(l, -EIO);
  }

  if (ft->invalidation_mutex_initialized && ft->invalidation_cond_initialized) {
    uv_mutex_lock(&(ft->invalidation_mut));
    uv_cond_broadcast(&(ft->invalidation_cond));
    uv_mutex_unlock(&(ft->invalidation_mut));
  }

  ft->cleanup_work.data = ft;
  int err = uv_queue_work(ft->loop, &(ft->cleanup_work), fuse_native_cleanup_work, fuse_native_cleanup_after);
  if (err < 0) {
    fuse_native_cleanup_work(&(ft->cleanup_work));
    fuse_native_cleanup_after(&(ft->cleanup_work), 0);
    return 0;
  }
  return 0;
}

static void fuse_native_env_cleanup (napi_async_cleanup_hook_handle handle, void *data) {
  (void) handle;
  fuse_thread_t *ft = (fuse_thread_t *) data;
  if (ft->mount_pending || ft->mount_cleanup_pending) {
    ft->env_cleanup = 1;
    atomic_store(&(ft->mount_cancelled), 1);
    return;
  }
  if (atomic_load(&(ft->cleanup_scheduled))) {
    ft->env_cleanup = 1;
    return;
  }
  fuse_native_begin_cleanup(ft, 1);
}

#define FUSE_MOUNT_ERROR_NONE 0
#define FUSE_MOUNT_ERROR_MOUNT 1
#define FUSE_MOUNT_ERROR_INIT 2
#define FUSE_MOUNT_ERROR_CANCELLED 3
#define FUSE_MOUNT_ERROR_THREAD 4

static void fuse_native_mount_work (uv_work_t *request) {
  fuse_thread_t *ft = (fuse_thread_t *) request->data;
  if (atomic_load(&(ft->mount_cancelled))) {
    ft->mount_error = FUSE_MOUNT_ERROR_CANCELLED;
    return;
  }

  int argc = ft->mntopts[0] == '\0' ? 1 : 2;
  char *argv[] = {
    (char *) "fuse_bindings_dummy",
    ft->mntopts
  };
  struct fuse_args args = FUSE_ARGS_INIT(argc, argv);

  ft->fuse = fuse_new(&args, &(ft->ops), sizeof(ft->ops), ft);
  if (ft->fuse == NULL) {
    ft->mount_error = FUSE_MOUNT_ERROR_INIT;
    fuse_opt_free_args(&args);
    return;
  }
  if (atomic_load(&(ft->mount_cancelled))) {
    ft->mount_error = FUSE_MOUNT_ERROR_CANCELLED;
    fuse_opt_free_args(&args);
    return;
  }

  fuse_opt_free_args(&args);
  if (fuse_mount(ft->fuse, ft->mnt) != 0) {
    ft->mount_error = FUSE_MOUNT_ERROR_MOUNT;
    return;
  }
  ft->fuse_mounted = 1;
  if (atomic_load(&(ft->mount_cancelled))) {
    ft->mount_error = FUSE_MOUNT_ERROR_CANCELLED;
  }
}

static void fuse_native_call_mount_callback (fuse_thread_t *ft) {
  if (ft->mount_cb == NULL || ft->env_cleanup) return;

  napi_handle_scope scope;
  if (napi_open_handle_scope(ft->env, &scope) != napi_ok) return;
  napi_value callback;
  napi_value receiver;
  napi_value argument;
  if (napi_get_reference_value(ft->env, ft->mount_cb, &callback) != napi_ok ||
      napi_get_reference_value(ft->env, ft->ctx, &receiver) != napi_ok) {
    napi_close_handle_scope(ft->env, scope);
    return;
  }

  if (ft->mount_error == FUSE_MOUNT_ERROR_NONE) {
    napi_get_null(ft->env, &argument);
  } else {
    const char *code = "EFUSEINIT";
    const char *message = "Failed to initialize the native FUSE mount";
    if (ft->mount_error == FUSE_MOUNT_ERROR_MOUNT) {
      code = "EFUSEMOUNT";
      message = "libfuse failed to mount the requested mountpoint";
    } else if (ft->mount_error == FUSE_MOUNT_ERROR_CANCELLED) {
      code = "EFUSEMOUNTCANCELLED";
      message = "The native FUSE mount was cancelled";
    } else if (ft->mount_error == FUSE_MOUNT_ERROR_THREAD) {
      code = "EFUSETHREAD";
      message = "Failed to start the bounded FUSE worker pool";
    }
    napi_value code_value;
    napi_value message_value;
    napi_create_string_utf8(ft->env, code, NAPI_AUTO_LENGTH, &code_value);
    napi_create_string_utf8(ft->env, message, NAPI_AUTO_LENGTH, &message_value);
    napi_create_error(ft->env, code_value, message_value, &argument);
  }

  napi_status status = napi_make_callback(
    ft->env,
    NULL,
    receiver,
    callback,
    1,
    &argument,
    NULL
  );
  if (status == napi_pending_exception) {
    napi_value exception;
    if (napi_get_and_clear_last_exception(ft->env, &exception) == napi_ok) {
      napi_fatal_exception(ft->env, exception);
    }
  }
  napi_close_handle_scope(ft->env, scope);
}

static void fuse_native_mount_after (uv_work_t *request, int status) {
  fuse_thread_t *ft = (fuse_thread_t *) request->data;
  ft->mount_pending = 0;
  if (status < 0 && ft->mount_error == FUSE_MOUNT_ERROR_NONE) {
    ft->mount_error = FUSE_MOUNT_ERROR_INIT;
  }
  if (atomic_load(&(ft->mount_cancelled)) &&
      ft->mount_error == FUSE_MOUNT_ERROR_NONE) {
    ft->mount_error = FUSE_MOUNT_ERROR_CANCELLED;
  }
  if (ft->mount_error == FUSE_MOUNT_ERROR_NONE) {
    int result = pthread_create(&(ft->thread), &(ft->attr), start_fuse_thread, ft);
    if (result == 0) {
      ft->thread_started = 1;
      ft->mounted = 1;
    } else {
      ft->cleanup_error = result;
      ft->mount_error = FUSE_MOUNT_ERROR_THREAD;
    }
  }
  if (ft->mount_error != FUSE_MOUNT_ERROR_NONE) {
    ft->mount_cleanup_pending = 1;
  }

  fuse_native_call_mount_callback(ft);
  if (ft->mount_cb != NULL) {
    napi_delete_reference(ft->env, ft->mount_cb);
    ft->mount_cb = NULL;
  }
  if (ft->mount_error != FUSE_MOUNT_ERROR_NONE) {
    fuse_native_mount_cleanup(ft);
  }
}

NAPI_METHOD(fuse_native_mount) {
  NAPI_ARGV(12)

  NAPI_ARGV_BUFFER_CAST(fuse_thread_t *, ft, 2);
  if (ft_len < sizeof(*ft)) {
    napi_throw_range_error(env, "EINVAL", "Invalid native thread state buffer");
    return NULL;
  }
  memset(ft, 0, sizeof(*ft));
  atomic_init(&(ft->cleanup_scheduled), 0);
  atomic_init(&(ft->cleanup_requested), 0);
  atomic_init(&(ft->loop_result), 0);
  atomic_init(&(ft->mount_cancelled), 0);
  ft->env = env;
  if (napi_create_reference(env, argv[2], 1, &(ft->state_ref)) != napi_ok) {
    napi_throw_error(env, "EFUSEINIT", "Failed to retain the native thread state");
    return NULL;
  }

  ft->mnt = fuse_native_string(env, argv[0]);
  ft->mntopts = fuse_native_string(env, argv[1]);
  if (ft->mnt == NULL || ft->mntopts == NULL) {
    fuse_native_mount_cleanup(ft);
    napi_throw_type_error(env, "EINVAL", "Mountpoint and mount options must be strings");
    return NULL;
  }

  uint64_t configured_max_read = 0;
  if (napi_get_value_bool(env, argv[10], &(ft->max_read_configured)) != napi_ok) {
    fuse_native_mount_cleanup(ft);
    napi_throw_type_error(env, "EINVAL", "Configured maxRead presence must be a boolean");
    return NULL;
  }
  if (value_to_uint64(env, argv[11], &configured_max_read) != 0 ||
      configured_max_read > UINT32_MAX ||
      (!ft->max_read_configured && configured_max_read != 0)) {
    fuse_native_mount_cleanup(ft);
    napi_throw_range_error(env, "EINVAL", "Invalid configured maxRead state");
    return NULL;
  }
  ft->configured_max_read = (uint32_t) configured_max_read;

  napi_valuetype loop_exit_type;
  napi_valuetype mount_callback_type;
  if (napi_typeof(env, argv[8], &loop_exit_type) != napi_ok ||
      napi_typeof(env, argv[9], &mount_callback_type) != napi_ok ||
      loop_exit_type != napi_function ||
      mount_callback_type != napi_function ||
      napi_get_uv_event_loop(env, &(ft->loop)) != napi_ok ||
      napi_create_reference(env, argv[3], 1, &(ft->ctx)) != napi_ok ||
      napi_create_reference(env, argv[8], 1, &(ft->loop_exit_cb)) != napi_ok ||
      napi_create_reference(env, argv[9], 1, &(ft->mount_cb)) != napi_ok) {
    fuse_native_mount_cleanup(ft);
    napi_throw_error(env, "EFUSEINIT", "Failed to initialize the native Node.js context");
    return NULL;
  }

  napi_value handlers = argv[4];
  uint32_t *implemented = NULL;
  size_t implemented_len = 0;
  if (get_uint32_array(env, argv[5], &implemented, &implemented_len) != 0 ||
      implemented_len != FUSE_OPERATION_COUNT) {
    fuse_native_mount_cleanup(ft);
    napi_throw_range_error(env, "EINVAL", "Invalid implemented-operation buffer");
    return NULL;
  }
  uint32_t max_workers = 0;
  if (napi_get_value_uint32(env, argv[6], &max_workers) != napi_ok ||
      max_workers == 0 ||
      max_workers > FUSE_MAX_WORKERS) {
    fuse_native_mount_cleanup(ft);
    napi_throw_range_error(env, "EINVAL", "maxConcurrency must be between 1 and 64");
    return NULL;
  }
  ft->max_workers = (size_t) max_workers;
  uint32_t operation_flags = 0;
  if (napi_get_value_uint32(env, argv[7], &operation_flags) != napi_ok ||
      (operation_flags & ~FUSE_OPERATION_FLAGS_ALLOWED) != 0) {
    fuse_native_mount_cleanup(ft);
    napi_throw_range_error(env, "EINVAL", "Invalid FUSE operation flags");
    return NULL;
  }

  bool handlers_is_array = false;
  uint32_t handlers_length = 0;
  if (napi_is_array(env, handlers, &handlers_is_array) != napi_ok ||
      !handlers_is_array ||
      napi_get_array_length(env, handlers, &handlers_length) != napi_ok ||
      handlers_length != FUSE_OPERATION_COUNT) {
    fuse_native_mount_cleanup(ft);
    napi_throw_type_error(env, "EINVAL", "Unexpected FUSE operation-handler count");
    return NULL;
  }

  for (uint32_t i = 0; i < handlers_length; i++) {
    ft->implemented[i] = implemented[i] != 0;
    napi_value handler;
    napi_valuetype type;
    if (napi_get_element(env, handlers, i, &handler) != napi_ok ||
        napi_typeof(env, handler, &type) != napi_ok) {
      fuse_native_mount_cleanup(ft);
      napi_throw_type_error(env, "EINVAL", "Invalid FUSE operation handler");
      return NULL;
    }
    if (type == napi_function) {
      if (napi_create_reference(env, handler, 1, &ft->handlers[i]) == napi_ok) continue;
      fuse_native_mount_cleanup(ft);
      napi_throw_error(env, "EFUSEINIT", "Failed to retain a FUSE operation handler");
      return NULL;
    }
    if (implemented[i]) {
      fuse_native_mount_cleanup(ft);
      napi_throw_type_error(env, "EINVAL", "An implemented FUSE operation has no handler");
      return NULL;
    }
  }

  memset(&(ft->ops), 0, sizeof(ft->ops));
  if (implemented[op_access]) ft->ops.access = fuse_native_access;
  if (implemented[op_truncate] || implemented[op_ftruncate]) {
    ft->ops.truncate = fuse_native_truncate_v3;
  }
  if (implemented[op_getattr] || implemented[op_fgetattr]) {
    ft->ops.getattr = fuse_native_getattr_v3;
  }
  if (implemented[op_flush]) ft->ops.flush = fuse_native_flush;
  if (implemented[op_fsync]) ft->ops.fsync = fuse_native_fsync;
  if (implemented[op_fsyncdir]) ft->ops.fsyncdir = fuse_native_fsyncdir;
  if (implemented[op_readdir]) ft->ops.readdir = fuse_native_readdir;
  if (implemented[op_readlink]) ft->ops.readlink = fuse_native_readlink;
  if (implemented[op_chown]) ft->ops.chown = fuse_native_chown;
  if (implemented[op_chmod]) ft->ops.chmod = fuse_native_chmod;
  if (implemented[op_mknod]) ft->ops.mknod = fuse_native_mknod;
  if (implemented[op_setxattr]) ft->ops.setxattr = fuse_native_setxattr;
  if (implemented[op_getxattr]) ft->ops.getxattr = fuse_native_getxattr;
  if (implemented[op_listxattr]) ft->ops.listxattr = fuse_native_listxattr;
  if (implemented[op_removexattr]) ft->ops.removexattr = fuse_native_removexattr;
#if defined(__APPLE__) && FUSE_DARWIN_ENABLE_EXTENSIONS
  if (implemented[op_statfs]) ft->ops.statfs = fuse_native_statfs_darwin;
  if (implemented[op_chmod] || implemented[op_chown] ||
      implemented[op_truncate] || implemented[op_ftruncate] ||
      implemented[op_utimens]) {
    ft->ops.setattr = fuse_native_setattr_darwin;
  }
#else
  if (implemented[op_statfs]) ft->ops.statfs = fuse_native_statfs;
#endif
  if (implemented[op_open]) ft->ops.open = fuse_native_open;
  if (implemented[op_opendir]) ft->ops.opendir = fuse_native_opendir;
  if (implemented[op_read]) ft->ops.read = fuse_native_read;
  if (implemented[op_write]) ft->ops.write = fuse_native_write;
  if (implemented[op_release]) ft->ops.release = fuse_native_release;
  if (implemented[op_releasedir]) ft->ops.releasedir = fuse_native_releasedir;
  if (implemented[op_create]) ft->ops.create = fuse_native_create;
  if (implemented[op_utimens]) ft->ops.utimens = fuse_native_utimens;
  if (implemented[op_unlink]) ft->ops.unlink = fuse_native_unlink;
  if (implemented[op_rename]) ft->ops.rename = fuse_native_rename;
  if (implemented[op_link]) ft->ops.link = fuse_native_link;
  if (implemented[op_symlink]) ft->ops.symlink = fuse_native_symlink;
  if (implemented[op_mkdir]) ft->ops.mkdir = fuse_native_mkdir;
  if (implemented[op_rmdir]) ft->ops.rmdir = fuse_native_rmdir;
  /*
   * Always install init so the legacy null-path options can be translated to
   * fuse_config even when no JavaScript init handler is present.
   */
  ft->ops.init = fuse_native_init;
  if (implemented[op_destroy]) ft->ops.destroy = fuse_native_destroy;
  if (implemented[op_lock]) ft->ops.lock = fuse_native_lock;
  if (implemented[op_bmap]) ft->ops.bmap = fuse_native_bmap;
  if (implemented[op_ioctl]) ft->ops.ioctl = fuse_native_ioctl;
  if (implemented[op_poll]) ft->ops.poll = fuse_native_poll;
  if (implemented[op_write_buf]) ft->ops.write_buf = fuse_native_write_buf;
  if (implemented[op_read_buf]) ft->ops.read_buf = fuse_native_read_buf;
  if (implemented[op_flock]) ft->ops.flock = fuse_native_flock;
  if (implemented[op_fallocate]) ft->ops.fallocate = fuse_native_fallocate;
  if (implemented[op_copy_file_range]) {
    ft->ops.copy_file_range = fuse_native_copy_file_range;
  }
  if (implemented[op_lseek]) ft->ops.lseek = fuse_native_lseek;
#if defined(__linux__) && FUSE_VERSION >= FUSE_MAKE_VERSION(3, 18)
  if (implemented[op_getattr] || implemented[op_fgetattr]) {
    ft->ops.statx = fuse_native_statx;
  }
#endif
  ft->operation_flags = operation_flags;

  int err = 0;
#ifdef __APPLE__
  *(void **) (&(ft->buf_free)) = dlsym(RTLD_DEFAULT, "fuse_buf_free");
  if (ft->buf_free == NULL) {
    err = ENOSYS;
    goto mount_failed;
  }
#endif

  err = uv_mutex_init(&(ft->mut));
  if (err < 0) goto mount_failed;
  ft->mutex_initialized = 1;

  err = uv_mutex_init(&(ft->invalidation_mut));
  if (err < 0) goto mount_failed;
  ft->invalidation_mutex_initialized = 1;

  err = uv_cond_init(&(ft->invalidation_cond));
  if (err < 0) goto mount_failed;
  ft->invalidation_cond_initialized = 1;

  err = uv_sem_init(&(ft->workers_finished), 0);
  if (err < 0) goto mount_failed;
  ft->workers_sem_initialized = 1;

  err = uv_async_init(
    ft->loop,
    &(ft->loop_exit_async),
    (uv_async_cb) fuse_native_loop_exit_dispatch
  );
  if (err < 0) goto mount_failed;
  ft->loop_exit_async_initialized = 1;
  ft->loop_exit_async.data = ft;
  uv_unref((uv_handle_t *) &(ft->loop_exit_async));

  err = fuse_native_create_worker_locals(ft);
  if (err < 0) goto mount_failed;

  err = pthread_attr_init(&(ft->attr));
  if (err != 0) goto mount_failed;
  ft->attr_initialized = 1;

  if (napi_add_async_cleanup_hook(env, fuse_native_env_cleanup, ft, &(ft->cleanup_hook)) != napi_ok) {
    err = UV_EINVAL;
    goto mount_failed;
  }

  ft->mount_work.data = ft;
  ft->mount_pending = 1;
  err = uv_queue_work(
    ft->loop,
    &(ft->mount_work),
    fuse_native_mount_work,
    fuse_native_mount_after
  );
  if (err < 0) {
    ft->mount_pending = 0;
    goto mount_failed;
  }

  return NULL;

mount_failed:
  fuse_native_mount_cleanup(ft);
  napi_throw_error(env, "EFUSEINIT", err < 0 ? uv_strerror(err) : strerror(err));
  return NULL;
}

NAPI_METHOD(fuse_native_unmount) {
  NAPI_ARGV(2)
  NAPI_ARGV_BUFFER_CAST(fuse_thread_t *, ft, 0);
  if (ft_len < sizeof(*ft) || !ft->mounted) {
    napi_throw_error(env, "EINVAL", "FUSE filesystem is not mounted");
    return NULL;
  }

  napi_valuetype callback_type;
  if (napi_typeof(env, argv[1], &callback_type) != napi_ok ||
      callback_type != napi_function) {
    napi_throw_type_error(env, "EINVAL", "Unmount callback must be a function");
    return NULL;
  }

  if (napi_create_reference(env, argv[1], 1, &(ft->cleanup_cb)) != napi_ok) {
    napi_throw_error(env, "EFUSECLEANUP", "Failed to retain the unmount callback");
    return NULL;
  }

  int err = fuse_native_begin_cleanup(ft, 0);
  if (err < 0) {
    napi_delete_reference(env, ft->cleanup_cb);
    ft->cleanup_cb = NULL;
    napi_throw_error(env, "EFUSECLEANUP", uv_strerror(err));
    return NULL;
  }

  return NULL;
}

/*
 * Register a local file descriptor with the kernel and return its backing
 * id, so a later open can reply with FOPEN_PASSTHROUGH and take the daemon
 * out of the data path. This is exactly what libfuse's low-level
 * fuse_passthrough_open() does; the high-level API reaches the same session
 * fd through fuse_get_session().
 *
 * Returns the id (> 0) on success, or -errno. The caller decides whether a
 * failure is fatal; computerd falls back to pread/pwrite for that file.
 */
NAPI_METHOD(fuse_native_backing_open) {
  NAPI_ARGV(2)
  NAPI_ARGV_BUFFER_CAST(fuse_thread_t *, ft, 0);
  uint32_t fd = 0;

  if (ft_len < sizeof(*ft) ||
      napi_get_value_uint32(env, argv[1], &fd) != napi_ok) {
    napi_throw_type_error(env, "EINVAL", "Invalid backing open request");
    return NULL;
  }

#if FUSE_HAS_BACKING_ID
  int32_t result = -ENOTSUP;
  struct fuse_session *session = NULL;

  uv_mutex_lock(&(ft->invalidation_mut));
  if (!atomic_load(&(ft->cleanup_requested)) && ft->mounted && ft->fuse != NULL) {
    session = fuse_get_session(ft->fuse);
  }
  uv_mutex_unlock(&(ft->invalidation_mut));

  if (session == NULL) {
    result = -ENOTCONN;
  } else {
    int session_fd = fuse_session_fd(session);
    if (session_fd < 0) {
      result = -ENOTCONN;
    } else {
      struct fuse_backing_map map;
      memset(&map, 0, sizeof(map));
      map.fd = (int32_t) fd;
      int id = ioctl(session_fd, FUSE_DEV_IOC_BACKING_OPEN, &map);
      result = id > 0 ? (int32_t) id : (int32_t) -errno;
    }
  }

  NAPI_RETURN_INT32(result)
#else
  NAPI_RETURN_INT32(-ENOTSUP)
#endif
}

/* Release a backing id. Safe to call once, on the last release of a file. */
NAPI_METHOD(fuse_native_backing_close) {
  NAPI_ARGV(2)
  NAPI_ARGV_BUFFER_CAST(fuse_thread_t *, ft, 0);
  uint32_t backing_id = 0;

  if (ft_len < sizeof(*ft) ||
      napi_get_value_uint32(env, argv[1], &backing_id) != napi_ok ||
      backing_id == 0) {
    napi_throw_type_error(env, "EINVAL", "Invalid backing close request");
    return NULL;
  }

#if FUSE_HAS_BACKING_ID
  int32_t result = -ENOTSUP;
  struct fuse_session *session = NULL;

  uv_mutex_lock(&(ft->invalidation_mut));
  if (!atomic_load(&(ft->cleanup_requested)) && ft->mounted && ft->fuse != NULL) {
    session = fuse_get_session(ft->fuse);
  }
  uv_mutex_unlock(&(ft->invalidation_mut));

  if (session == NULL) {
    result = -ENOTCONN;
  } else {
    int session_fd = fuse_session_fd(session);
    if (session_fd < 0) {
      result = -ENOTCONN;
    } else {
      uint32_t id = backing_id;
      result = ioctl(session_fd, FUSE_DEV_IOC_BACKING_CLOSE, &id) == 0
        ? 0
        : (int32_t) -errno;
    }
  }

  NAPI_RETURN_INT32(result)
#else
  NAPI_RETURN_INT32(-ENOTSUP)
#endif
}

NAPI_METHOD(fuse_native_invalidate_entry) {
  NAPI_ARGV(4)
  NAPI_ARGV_BUFFER_CAST(fuse_thread_t *, ft, 0);
  uint64_t parent = 0;
  size_t name_size = 0;
  napi_valuetype callback_type;

  if (ft_len < sizeof(*ft) ||
      value_to_uint64(env, argv[1], &parent) != 0 ||
      parent == 0 ||
      napi_get_value_string_utf8(env, argv[2], NULL, 0, &name_size) != napi_ok ||
      napi_typeof(env, argv[3], &callback_type) != napi_ok ||
      callback_type != napi_function) {
    napi_throw_type_error(env, "EINVAL", "Invalid FUSE entry invalidation request");
    return NULL;
  }

  fuse_invalidation_request_t *request = calloc(1, sizeof(*request));
  if (request == NULL) {
    napi_throw_error(env, "ENOMEM", "Failed to allocate FUSE invalidation request");
    return NULL;
  }
  request->name = fuse_native_string(env, argv[2]);
  if (request->name == NULL) {
    free(request);
    napi_throw_error(env, "ENOMEM", "Failed to allocate FUSE entry name");
    return NULL;
  }
  request->name_length = strlen(request->name);
  request->parent = parent;
  if (request->name_length == 0 ||
      request->name_length != name_size ||
      request->name_length > 255 ||
      strchr(request->name, '/') != NULL) {
    free(request->name);
    free(request);
    napi_throw_range_error(env, "EINVAL", "FUSE entry name must be one NUL-free path component");
    return NULL;
  }

  napi_value resource_name;
  if (napi_create_string_utf8(
        env,
        "fuse-napi:invalidate-entry",
        NAPI_AUTO_LENGTH,
        &resource_name
      ) != napi_ok ||
      napi_create_threadsafe_function(
        env,
        argv[3],
        NULL,
        resource_name,
        1,
        1,
        request,
        fuse_native_invalidation_finalize,
        NULL,
        fuse_native_invalidation_dispatch,
        &(request->callback)
      ) != napi_ok) {
    free(request->name);
    free(request);
    napi_throw_error(env, "EFUSEINVALIDATE", "Failed to retain the invalidation callback");
    return NULL;
  }

  int32_t result = 0;
  bool queued = false;
  if (!ft->mounted ||
      atomic_load(&(ft->cleanup_requested)) ||
      !ft->invalidation_mutex_initialized ||
      !ft->invalidation_cond_initialized ||
      !ft->attr_initialized) {
    result = -ENOTCONN;
  } else {
    uv_mutex_lock(&(ft->invalidation_mut));
    if (!ft->mounted ||
        atomic_load(&(ft->cleanup_requested)) ||
        ft->invalidation_stopping) {
      result = -ENOTCONN;
    } else if (ft->invalidation_pending >= FUSE_MAX_PENDING_INVALIDATIONS) {
      result = -EAGAIN;
    } else {
      if (!ft->invalidation_thread_started) {
        int err = pthread_create(
          &(ft->invalidation_thread),
          &(ft->attr),
          fuse_native_invalidation_worker,
          ft
        );
        if (err != 0) {
          result = -err;
        } else {
          ft->invalidation_thread_started = 1;
        }
      }
      if (result == 0) {
        if (ft->invalidation_tail == NULL) {
          ft->invalidation_head = request;
        } else {
          ft->invalidation_tail->next = request;
        }
        ft->invalidation_tail = request;
        ft->invalidation_pending++;
        queued = true;
        uv_cond_signal(&(ft->invalidation_cond));
      }
    }
    uv_mutex_unlock(&(ft->invalidation_mut));
  }

  if (!queued) fuse_native_complete_invalidation(request, result);
  return NULL;
}

NAPI_METHOD(fuse_native_notify_poll) {
  NAPI_ARGV(2)
  NAPI_ARGV_BUFFER_CAST(fuse_thread_t *, ft, 0);
  uint64_t id = 0;
  if (ft_len < sizeof(*ft) || value_to_uint64(env, argv[1], &id) != 0 || id == 0) {
    napi_throw_type_error(env, "EINVAL", "Invalid native poll handle");
    return NULL;
  }

  bool notified = false;
  if (!atomic_load(&(ft->cleanup_requested)) && ft->mutex_initialized) {
    uv_mutex_lock(&(ft->mut));
    for (fuse_poll_registration_t *registration = ft->polls;
         registration != NULL;
         registration = registration->next) {
      if (registration->id == id && registration->handle != NULL) {
        notified = fuse_notify_poll(registration->handle) == 0;
        break;
      }
    }
    uv_mutex_unlock(&(ft->mut));
  }

  napi_value result;
  napi_get_boolean(env, notified, &result);
  return result;
}

NAPI_METHOD(fuse_native_close_poll) {
  NAPI_ARGV(2)
  NAPI_ARGV_BUFFER_CAST(fuse_thread_t *, ft, 0);
  uint64_t id = 0;
  if (ft_len < sizeof(*ft) || value_to_uint64(env, argv[1], &id) != 0 || id == 0) {
    napi_throw_type_error(env, "EINVAL", "Invalid native poll handle");
    return NULL;
  }

  fuse_poll_registration_t *found = NULL;
  if (!atomic_load(&(ft->cleanup_requested)) && ft->mutex_initialized) {
    uv_mutex_lock(&(ft->mut));
    fuse_poll_registration_t **cursor = &(ft->polls);
    while (*cursor != NULL) {
      if ((*cursor)->id == id) {
        found = *cursor;
        *cursor = found->next;
        break;
      }
      cursor = &((*cursor)->next);
    }
    uv_mutex_unlock(&(ft->mut));
  }
  if (found != NULL) {
    struct fuse_pollhandle *handle = found->handle;
    found->handle = NULL;
    if (handle != NULL) fuse_pollhandle_destroy(handle);
    fuse_native_release_poll_registration(found);
  }

  napi_value result;
  napi_get_boolean(env, found != NULL, &result);
  return result;
}

NAPI_METHOD(fuse_native_runtime_info) {
  (void) info;
  napi_value result;
  napi_value version;
  napi_value api_version;
  napi_value buffer_release;
  napi_value statx;
  const char *package_version = fuse_pkgversion();
  bool has_buffer_release = true;
  bool has_statx = false;
#ifdef __APPLE__
  has_buffer_release = dlsym(RTLD_DEFAULT, "fuse_buf_free") != NULL;
#endif
#if defined(__linux__) && FUSE_VERSION >= FUSE_MAKE_VERSION(3, 18)
  has_statx = true;
#endif

  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf8(
        env,
        package_version == NULL ? "" : package_version,
        NAPI_AUTO_LENGTH,
        &version
      ) != napi_ok ||
      napi_create_uint32(env, (uint32_t) fuse_version(), &api_version) != napi_ok ||
      napi_get_boolean(env, has_buffer_release, &buffer_release) != napi_ok ||
      napi_get_boolean(env, has_statx, &statx) != napi_ok ||
      napi_set_named_property(env, result, "version", version) != napi_ok ||
      napi_set_named_property(env, result, "apiVersion", api_version) != napi_ok ||
      napi_set_named_property(
        env,
        result,
        "hasBufferRelease",
        buffer_release
      ) != napi_ok ||
      napi_set_named_property(
        env,
        result,
        "hasStatx",
        statx
      ) != napi_ok) {
    napi_throw_error(env, "EFUSEINIT", "Failed to inspect the loaded libfuse runtime");
    return NULL;
  }

  return result;
}

NAPI_INIT() {
  if (pthread_once(&(thread_locals_once), create_thread_locals_key) != 0 ||
      thread_locals_status != 0) {
    napi_throw_error(env, "EFUSEINIT", "Failed to create FUSE thread-local storage");
    return;
  }

  NAPI_EXPORT_SIZEOF(fuse_thread_t)

  NAPI_EXPORT_FUNCTION(fuse_native_mount)
  NAPI_EXPORT_FUNCTION(fuse_native_cancel_mount)
  NAPI_EXPORT_FUNCTION(fuse_native_unmount)
  NAPI_EXPORT_FUNCTION(fuse_native_invalidate_entry)
  NAPI_EXPORT_FUNCTION(fuse_native_notify_poll)
  NAPI_EXPORT_FUNCTION(fuse_native_close_poll)
  NAPI_EXPORT_FUNCTION(fuse_native_runtime_info)

  NAPI_EXPORT_FUNCTION(fuse_native_signal_init)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_access)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_statfs)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_fgetattr)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_getattr)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_flush)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_fsync)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_fsyncdir)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_readdir)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_truncate)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_ftruncate)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_utimens)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_readlink)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_chown)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_chmod)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_mknod)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_setxattr)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_getxattr)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_listxattr)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_removexattr)
  NAPI_EXPORT_FUNCTION(fuse_native_backing_open)
  NAPI_EXPORT_FUNCTION(fuse_native_backing_close)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_open)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_opendir)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_read)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_write)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_release)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_releasedir)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_create)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_unlink)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_rename)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_link)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_symlink)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_mkdir)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_rmdir)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_destroy)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_lock)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_bmap)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_ioctl)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_poll)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_write_buf)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_read_buf)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_flock)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_fallocate)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_copy_file_range)
  NAPI_EXPORT_FUNCTION(fuse_native_signal_lseek)

  NAPI_EXPORT_UINT32(op_init)
  NAPI_EXPORT_UINT32(op_error)
  NAPI_EXPORT_UINT32(op_access)
  NAPI_EXPORT_UINT32(op_statfs)
  NAPI_EXPORT_UINT32(op_fgetattr)
  NAPI_EXPORT_UINT32(op_getattr)
  NAPI_EXPORT_UINT32(op_flush)
  NAPI_EXPORT_UINT32(op_fsync)
  NAPI_EXPORT_UINT32(op_fsyncdir)
  NAPI_EXPORT_UINT32(op_readdir)
  NAPI_EXPORT_UINT32(op_truncate)
  NAPI_EXPORT_UINT32(op_ftruncate)
  NAPI_EXPORT_UINT32(op_utimens)
  NAPI_EXPORT_UINT32(op_readlink)
  NAPI_EXPORT_UINT32(op_chown)
  NAPI_EXPORT_UINT32(op_chmod)
  NAPI_EXPORT_UINT32(op_mknod)
  NAPI_EXPORT_UINT32(op_setxattr)
  NAPI_EXPORT_UINT32(op_getxattr)
  NAPI_EXPORT_UINT32(op_listxattr)
  NAPI_EXPORT_UINT32(op_removexattr)
  NAPI_EXPORT_UINT32(op_open)
  NAPI_EXPORT_UINT32(op_opendir)
  NAPI_EXPORT_UINT32(op_read)
  NAPI_EXPORT_UINT32(op_write)
  NAPI_EXPORT_UINT32(op_release)
  NAPI_EXPORT_UINT32(op_releasedir)
  NAPI_EXPORT_UINT32(op_create)
  NAPI_EXPORT_UINT32(op_unlink)
  NAPI_EXPORT_UINT32(op_rename)
  NAPI_EXPORT_UINT32(op_link)
  NAPI_EXPORT_UINT32(op_symlink)
  NAPI_EXPORT_UINT32(op_mkdir)
  NAPI_EXPORT_UINT32(op_rmdir)
  NAPI_EXPORT_UINT32(op_destroy)
  NAPI_EXPORT_UINT32(op_lock)
  NAPI_EXPORT_UINT32(op_bmap)
  NAPI_EXPORT_UINT32(op_ioctl)
  NAPI_EXPORT_UINT32(op_poll)
  NAPI_EXPORT_UINT32(op_write_buf)
  NAPI_EXPORT_UINT32(op_read_buf)
  NAPI_EXPORT_UINT32(op_flock)
  NAPI_EXPORT_UINT32(op_fallocate)
  NAPI_EXPORT_UINT32(op_copy_file_range)
  NAPI_EXPORT_UINT32(op_lseek)
}
