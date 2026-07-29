#include <node_api.h>
#include <errno.h>
#include <string.h>
#include <stdio.h>

#if defined(__APPLE__)
#include <unistd.h>
#ifndef RENAME_EXCL
#define RENAME_EXCL 0x00000004
#endif
int renamex_np(const char *from, const char *to, unsigned int flags);
#elif defined(__linux__)
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
/* renameat2 is in glibc >= 2.28 */
int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags);
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
#ifndef AT_FDCWD
#define AT_FDCWD -100
#endif
#else
#error "unsupported platform for rename no-replace"
#endif

static napi_value RenameNoReplace(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_status st = napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (st != napi_ok || argc < 2) {
    napi_throw_error(env, NULL, "renameNoReplace(from, to) requires 2 arguments");
    return NULL;
  }

  char from[4096];
  char to[4096];
  size_t from_len = 0;
  size_t to_len = 0;
  st = napi_get_value_string_utf8(env, args[0], from, sizeof(from), &from_len);
  if (st != napi_ok || from_len == 0 || from_len >= sizeof(from)) {
    napi_throw_error(env, "EINVAL", "invalid from path");
    return NULL;
  }
  st = napi_get_value_string_utf8(env, args[1], to, sizeof(to), &to_len);
  if (st != napi_ok || to_len == 0 || to_len >= sizeof(to)) {
    napi_throw_error(env, "EINVAL", "invalid to path");
    return NULL;
  }

  int rc;
#if defined(__APPLE__)
  rc = renamex_np(from, to, RENAME_EXCL);
#elif defined(__linux__)
  rc = renameat2(AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE);
#endif

  if (rc == 0) {
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
  }

  int err = errno;
  const char *code = "UNKNOWN";
  if (err == EEXIST || err == ENOTEMPTY) code = "EEXIST";
  else if (err == ENOENT) code = "ENOENT";
  else if (err == EXDEV) code = "EXDEV";
  else if (err == ENOTDIR) code = "ENOTDIR";
  else if (err == EISDIR) code = "EISDIR";
  else if (err == EACCES || err == EPERM) code = "EACCES";
  else if (err == EINVAL) code = "EINVAL";

  char msg[512];
  snprintf(msg, sizeof(msg), "rename no-replace failed: %s", strerror(err));
  napi_value error;
  napi_value msg_v;
  napi_value code_v;
  napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &msg_v);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_v);
  napi_create_error(env, code_v, msg_v, &error);

  /* Attach .code for Node-style catch */
  napi_set_named_property(env, error, "code", code_v);
  napi_value errno_v;
  napi_create_int32(env, err, &errno_v);
  napi_set_named_property(env, error, "errno", errno_v);

  napi_throw(env, error);
  return NULL;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "renameNoReplace", NAPI_AUTO_LENGTH, RenameNoReplace, NULL, &fn);
  napi_set_named_property(env, exports, "renameNoReplace", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
