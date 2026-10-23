#define _GNU_SOURCE
#include <node_api.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>

#if defined(__linux__)
#include <fcntl.h>
#include <linux/openat2.h>
#include <linux/mount.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdio.h>
#include <limits.h>
#endif

typedef struct {
  char *source_root;
  char *target_root;
  char *relative;
  napi_async_work work;
  napi_deferred deferred;
  int result;
  int action; // 0 bind, 1 detach, 2 open
} bind_job;

#if defined(__linux__)
static int valid_relative(const char *path) {
  if (!path || !*path || *path == '/') return 0;
  size_t size = strlen(path);
  if (size >= PATH_MAX || path[size - 1] == '/') return 0;
  const char *part = path;
  while (*part) {
    const char *end = strchr(part, '/');
    size_t length = end ? (size_t)(end - part) : strlen(part);
    if (!length || (length == 1 && part[0] == '.') ||
        (length == 2 && part[0] == '.' && part[1] == '.')) return 0;
    if (!end) break;
    part = end + 1;
  }
  return 1;
}

static int resolve_directory(int root, const char *path) {
  struct open_how how = {
    .flags = O_PATH | O_DIRECTORY | O_CLOEXEC,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS
  };
  return (int)syscall(SYS_openat2, root, path, &how, sizeof(how));
}

static int bind_confined(const char *source_root, const char *target_root, const char *relative) {
  int result = -EINVAL;
  int source_base = -1, target_base = -1, source = -1, target = -1, tree = -1;
  struct stat source_stat, mounted_stat;
  char tree_path[64], target_root_path[64];
  if (!valid_relative(relative)) return result;
  source_base = open(source_root, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (source_base < 0) { result = -errno; goto done; }
  target_base = open(target_root, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (target_base < 0) { result = -errno; goto done; }
  source = resolve_directory(source_base, relative);
  if (source < 0) { result = -errno; goto done; }
  target = resolve_directory(target_base, relative);
  if (target < 0) { result = -errno; goto done; }
  if (fstat(source, &source_stat) != 0) { result = -errno; goto done; }
  // The propagation of an attachment is controlled by the parent mount,
  // not the cloned child's propagation. Make the FUSE mount private before
  // attaching anything, or fail before creating a bind.
  snprintf(target_root_path, sizeof(target_root_path), "/proc/self/fd/%d", target_base);
  if (mount(NULL, target_root_path, NULL, MS_PRIVATE | MS_REC, NULL) != 0) {
    result = -errno;
    goto done;
  }
  tree = (int)syscall(SYS_open_tree, source, "", OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH);
  if (tree < 0) { result = -errno; goto done; }
  // Verify the detached mount before attaching it. Nothing after move_mount
  // re-resolves the target path or can fail and strand a new mount.
  if (fstat(tree, &mounted_stat) != 0 ||
      source_stat.st_dev != mounted_stat.st_dev || source_stat.st_ino != mounted_stat.st_ino) {
    result = -EIO;
    goto done;
  }
  snprintf(tree_path, sizeof(tree_path), "/proc/self/fd/%d", tree);
  if (mount(NULL, tree_path, NULL, MS_PRIVATE | MS_REC, NULL) != 0) {
    result = -errno;
    goto done;
  }
  if (syscall(SYS_move_mount, tree, "", target, "",
              MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH) != 0) {
    result = -errno;
    goto done;
  }
  result = 0;
done:
  if (tree >= 0) close(tree);
  if (target >= 0) close(target);
  if (source >= 0) close(source);
  if (target_base >= 0) close(target_base);
  if (source_base >= 0) close(source_base);
  return result;
}
static int open_confined(const char *target_root, const char *relative) {
  if (!valid_relative(relative)) return -EINVAL;
  int base = open(target_root, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (base < 0) return -errno;
  int target = resolve_directory(base, relative);
  int result = target < 0 ? -errno : target;
  close(base);
  return result;
}

static int unbind_confined(const char *target_root, const char *relative) {
  if (!valid_relative(relative)) return -EINVAL;
  int base = open(target_root, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (base < 0) return -errno;
  int target = resolve_directory(base, relative);
  int result;
  if (target < 0) {
    result = -errno;
  } else {
    char path[64];
    snprintf(path, sizeof(path), "/proc/self/fd/%d", target);
    result = umount2(path, MNT_DETACH) == 0 ? 0 : -errno;
    close(target);
  }
  close(base);
  return result;
}
#endif

static void execute_bind(napi_env env, void *data) {
  (void)env;
  bind_job *job = data;
#if defined(__linux__)
  job->result = job->action == 1 ? unbind_confined(job->target_root, job->relative)
                : job->action == 2 ? open_confined(job->target_root, job->relative)
                : bind_confined(job->source_root, job->target_root, job->relative);
#else
  job->result = -ENOSYS;
#endif
}

static void complete_bind(napi_env env, napi_status status, void *data) {
  bind_job *job = data;
  napi_value value;
#if defined(__linux__)
  if (status != napi_ok && job->action == 2 && job->result >= 0) close(job->result);
#endif
  napi_create_int32(env, status == napi_ok ? job->result : -EIO, &value);
  napi_resolve_deferred(env, job->deferred, value);
  napi_delete_async_work(env, job->work);
  free(job->source_root);
  free(job->target_root);
  free(job->relative);
  free(job);
}

static char *copy_argument(napi_env env, napi_value value) {
  size_t length;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length >= 4096)
    return NULL;
  char *str = malloc(length + 1);
  if (!str) return NULL;
  size_t read;
  if (napi_get_value_string_utf8(env, value, str, length + 1, &read) != napi_ok ||
      read != length || strlen(str) != length) {
    free(str);
    return NULL;
  }
  return str;
}

static napi_value queue_bind(napi_env env, napi_callback_info info, int action) {
  napi_value args[3], promise, label;
  size_t argc = 3;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc != (action ? 2u : 3u)) {
    napi_throw_type_error(env, NULL, "bindRoot requires two roots and a relative path");
    return NULL;
  }
  bind_job *job = calloc(1, sizeof(*job));
  if (!job) { napi_throw_error(env, NULL, "Out of memory"); return NULL; }
  job->action = action;
  job->result = -EIO;
  job->source_root = action ? NULL : copy_argument(env, args[0]);
  job->target_root = copy_argument(env, args[action ? 0 : 1]);
  job->relative = copy_argument(env, args[action ? 1 : 2]);
  if ((!action && !job->source_root) || !job->target_root || !job->relative) {
    free(job->source_root); free(job->target_root); free(job->relative); free(job);
    napi_throw_type_error(env, NULL, "bindRoot requires short, NUL-free strings");
    return NULL;
  }
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "confined bind root", NAPI_AUTO_LENGTH, &label) != napi_ok ||
      napi_create_async_work(env, NULL, label, execute_bind, complete_bind, job, &job->work) != napi_ok ||
      napi_queue_async_work(env, job->work) != napi_ok) {
    if (job->work != NULL) napi_delete_async_work(env, job->work);
    free(job->source_root); free(job->target_root); free(job->relative); free(job);
    napi_throw_error(env, NULL, "Cannot queue confined bind");
    return NULL;
  }
  return promise;
}

napi_value fuse_native_bind_root(napi_env env, napi_callback_info info) {
  return queue_bind(env, info, 0);
}

napi_value fuse_native_unbind_root(napi_env env, napi_callback_info info) {
  return queue_bind(env, info, 1);
}

napi_value fuse_native_open_root(napi_env env, napi_callback_info info) {
  return queue_bind(env, info, 2);
}
