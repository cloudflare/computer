#ifndef COMPUTERD_REMOVAL_GUARD_H
#define COMPUTERD_REMOVAL_GUARD_H

#include <node_api.h>

/* Not upstream; see PATCHES.md. */
napi_value fuse_native_guard_start(napi_env env, napi_callback_info info);
napi_value fuse_native_guard_add_root(napi_env env, napi_callback_info info);
napi_value fuse_native_guard_remove_root(napi_env env, napi_callback_info info);
napi_value fuse_native_guard_stats(napi_env env, napi_callback_info info);

#endif
