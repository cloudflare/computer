const os = require('os')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { AsyncLocalStorage } = require('async_hooks')

const Nanoresource = require('nanoresource')
const { checkEnvironment } = require('./lib/environment')
const { wrapMacFuseLoadError } = require('./lib/macfuse')
const { loadNativeBinding } = require('./lib/native-binding')
const { validateFuse3Options } = require('./lib/fuse3-options')

const IS_OSX = os.platform() === 'darwin'
let binding
try {
  binding = loadNativeBinding(__dirname)
} catch (err) {
  throw IS_OSX ? wrapMacFuseLoadError(err) : err
}
const NATIVE_RUNTIME = Object.freeze(binding.fuse_native_runtime_info())

const OSX_FOLDER_ICON = '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericFolderIcon.icns'
const HAS_FOLDER_ICON = IS_OSX && fs.existsSync(OSX_FOLDER_ICON)
const DEFAULT_TIMEOUT = 15 * 1000
const UNMOUNT_POLL_INTERVAL = 10
const UNMOUNT_STABILITY_CHECKS = 3
const UNMOUNT_HELPER_UNSAFE_ENV_PREFIXES = ['LD_', 'DYLD_']
const DEFAULT_MAX_CONCURRENCY = 4
const MAX_MAX_CONCURRENCY = 64
const MAX_INT32 = 0x7fffffff
const MIN_INT32 = -0x80000000
const UTIME_NOW = 0x3fffffff
const UTIME_OMIT = 0x3ffffffe
const OPERATION_FLAG_NULL_PATH_OK = 1
const OPERATION_FLAG_NO_PATH = 2
const OPERATION_FLAG_UTIME_OMIT_OK = 4
const OPERATION_FLAG_DIRECT_IO = 8
const OPERATION_FLAG_POLL_HANDLE = 16
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const XATTR_NOT_FOUND = -(os.constants.errno.ENOATTR || os.constants.errno.ENODATA || 61)
const EMPTY_INIT_CONFIG = new Uint32Array(8)
const FILE_INFO_DIRECT_IO = 1
const FILE_INFO_KEEP_CACHE = 2
const FILE_INFO_NONSEEKABLE = 4
const FILE_INFO_RESULT_FIELDS = new Set(['fd', 'directIO', 'keepCache', 'nonseekable', 'backingId'])
const requestContexts = new AsyncLocalStorage()
const activeRequestContexts = new WeakSet()
const INIT_CONFIG_FIELDS = new Map([
  ['maxWrite', { index: 1, mask: 1, minimum: 1 }],
  ['maxReadahead', { index: 2, mask: 2, minimum: 0 }],
  ['maxBackground', { index: 3, mask: 4, minimum: 1 }],
  ['congestionThreshold', { index: 4, mask: 8, minimum: 1 }],
  ['want', { index: 5, mask: 16, minimum: 0 }],
  ['asyncRead', { index: 6, mask: 32, boolean: true }],
  ['maxBackingStackDepth', { index: 7, mask: 64, minimum: 0 }]
])
const ENHANCED_OPERATIONS = new Map([
  ['initWithConfig', binding.op_init],
  ['readdirPaged', binding.op_readdir],
  ['createWithFlags', binding.op_create],
  ['utimensWithTimespec', binding.op_utimens],
  ['utimensWithHandle', binding.op_utimens],
  ['chownWithHandle', binding.op_chown],
  ['chmodWithHandle', binding.op_chmod],
  ['renameWithFlags', binding.op_rename],
  ['pollWithHandle', binding.op_poll]
])

const OpcodesAndDefaults = new Map([
  ['init', {
    op: binding.op_init,
    defaults: [EMPTY_INIT_CONFIG]
  }],
  ['error', {
    op: binding.op_error
  }],
  ['access', {
    op: binding.op_access,
    defaults: [0]
  }],
  ['statfs', {
    op: binding.op_statfs,
    defaults: [getStatfsArray()]
  }],
  ['fgetattr', {
    op: binding.op_fgetattr,
    defaults: [getStatArray()]
  }],
  ['getattr', {
    op: binding.op_getattr,
    defaults: [getStatArray()]
  }],
  ['flush', {
    op: binding.op_flush
  }],
  ['fsync', {
    op: binding.op_fsync
  }],
  ['fsyncdir', {
    op: binding.op_fsyncdir
  }],
  ['readdir', {
    op: binding.op_readdir,
    defaults: [[], [], new Uint32Array(0)]
  }],
  ['truncate', {
    op: binding.op_truncate
  }],
  ['ftruncate', {
    op: binding.op_ftruncate
  }],
  ['utimens', {
    op: binding.op_utimens
  }],
  ['readlink', {
    op: binding.op_readlink,
    defaults: ['']
  }],
  ['chown', {
    op: binding.op_chown
  }],
  ['chmod', {
    op: binding.op_chmod
  }],
  ['mknod', {
    op: binding.op_mknod
  }],
  ['setxattr', {
    op: binding.op_setxattr
  }],
  ['getxattr', {
    op: binding.op_getxattr
  }],
  ['listxattr', {
    op: binding.op_listxattr
  }],
  ['removexattr', {
    op: binding.op_removexattr
  }],
  ['open', {
    op: binding.op_open,
    defaults: [0, 0]
  }],
  ['opendir', {
    op: binding.op_opendir,
    defaults: [0, 0]
  }],
  ['read', {
    op: binding.op_read,
    defaults: [0]
  }],
  ['write', {
    op: binding.op_write,
    defaults: [0]
  }],
  ['release', {
    op: binding.op_release
  }],
  ['releasedir', {
    op: binding.op_releasedir
  }],
  ['create', {
    op: binding.op_create,
    defaults: [0, 0]
  }],
  ['unlink', {
    op: binding.op_unlink
  }],
  ['rename', {
    op: binding.op_rename
  }],
  ['link', {
    op: binding.op_link
  }],
  ['symlink', {
    op: binding.op_symlink
  }],
  ['mkdir', {
    op: binding.op_mkdir
  }],
  ['rmdir', {
    op: binding.op_rmdir
  }],
  ['destroy', {
    op: binding.op_destroy
  }],
  ['lock', {
    op: binding.op_lock
  }],
  ['bmap', {
    op: binding.op_bmap
  }],
  ['ioctl', {
    op: binding.op_ioctl
  }],
  ['poll', {
    op: binding.op_poll,
    defaults: [0]
  }],
  ['writeBuffer', {
    op: binding.op_write_buf,
    nativeName: 'write_buf'
  }],
  ['readBuffer', {
    op: binding.op_read_buf,
    nativeName: 'read_buf',
    defaults: [Buffer.alloc(0)]
  }],
  ['flock', {
    op: binding.op_flock
  }],
  ['fallocate', {
    op: binding.op_fallocate
  }],
  ['copyFileRange', {
    op: binding.op_copy_file_range,
    nativeName: 'copy_file_range',
    defaults: [new Uint32Array(2)]
  }],
  ['lseek', {
    op: binding.op_lseek,
    defaults: [new Uint32Array(2)]
  }]
])
const KNOWN_OPERATIONS = new Set([...OpcodesAndDefaults.keys(), ...ENHANCED_OPERATIONS.keys()])
const OPTION_ALIASES = new Map([
  ['allow_other', 'allowOther'],
  ['allow_root', 'allowRoot'],
  ['auto_unmount', 'autoUnmount'],
  ['default_permissions', 'defaultPermissions'],
  ['max_read', 'maxRead'],
  ['user_id', 'userId'],
  ['kernel_cache', 'kernelCache'],
  ['auto_cache', 'autoCache'],
  ['entry_timeout', 'entryTimeout'],
  ['attr_timeout', 'attrTimeout'],
  ['ac_attr_timeout', 'acAttrTimeout'],
  ['nonempty', 'nonEmpty'],
  ['direct_io', 'directIo'],
  ['nopath', 'noPath']
])
const KNOWN_OPTIONS = new Set([
  'uid', 'gid', 'timeout', 'displayFolder', 'debug', 'force', 'mkdir',
  'allowOther', 'allowRoot', 'autoUnmount', 'defaultPermissions', 'blkdev',
  'blksize', 'maxRead', 'nonEmpty', 'fd', 'userId', 'fsname', 'subtype',
  'kernelCache', 'autoCache', 'umask', 'entryTimeout', 'attrTimeout',
  'acAttrTimeout', 'noforget', 'remember', 'modules', 'name', 'onError',
  'maxConcurrency', 'nullPathOk', 'noPath', 'directIo'
])

const pollHandleFinalizer = new FinalizationRegistry(state => {
  if (state.closed) return
  state.closed = true
  try {
    binding.fuse_native_close_poll(state.thread, state.id)
  } catch {}
})

class PollHandle {
  constructor (thread, id) {
    this._state = { thread, id, closed: false }
    pollHandleFinalizer.register(this, this._state, this)
  }

  get closed () {
    return this._state.closed
  }

  notify () {
    if (this._state.closed) return false
    const notified = binding.fuse_native_notify_poll(this._state.thread, this._state.id)
    if (!notified) this.close()
    return notified
  }

  close () {
    if (this._state.closed) return false
    this._state.closed = true
    pollHandleFinalizer.unregister(this)
    return binding.fuse_native_close_poll(this._state.thread, this._state.id)
  }
}

class Fuse extends Nanoresource {
  static validateOptions (opts = {}) {
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError('Options must be an object')
    }
    normalizeAndValidateOptions(opts)
  }

  static checkEnvironment (opts = {}, cb) {
    if (typeof opts === 'function') {
      cb = opts
      opts = {}
    }
    let promise
    try {
      if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
        throw new TypeError('Environment options must be an object')
      }
      const normalized = normalizeAndValidateOptions(opts)
      promise = checkEnvironment(normalized, { nativeRuntime: NATIVE_RUNTIME })
    } catch (error) {
      promise = Promise.reject(error)
    }

    if (typeof cb !== 'function') return promise
    promise.then(
      report => process.nextTick(cb, null, report),
      err => process.nextTick(cb, err)
    )
  }

  constructor (mnt, ops = {}, opts = {}) {
    super()

    if (typeof mnt !== 'string' || mnt.length === 0 || mnt.includes('\0')) {
      throw new TypeError('Mountpoint must be a non-empty, NUL-free string')
    }
    if (!ops || typeof ops !== 'object' || Array.isArray(ops)) {
      throw new TypeError('Operations must be an object')
    }
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError('Options must be an object')
    }
    opts = normalizeAndValidateOptions(opts)
    validateOperations(ops)
    if (ops.error !== undefined) {
      throw new TypeError('Operation "error" is not a supported FUSE operation')
    }

    for (const [name] of OpcodesAndDefaults) {
      if (ops[name] !== undefined && typeof ops[name] !== 'function') {
        throw new TypeError(`Operation ${JSON.stringify(name)} must be a function`)
      }
    }
    for (const [name] of ENHANCED_OPERATIONS) {
      if (ops[name] !== undefined && typeof ops[name] !== 'function') {
        throw new TypeError(`Operation ${JSON.stringify(name)} must be a function`)
      }
    }
    for (const [legacy, enhanced] of [
      ['init', 'initWithConfig'],
      ['readdir', 'readdirPaged'],
      ['create', 'createWithFlags'],
      ['chown', 'chownWithHandle'],
      ['chmod', 'chmodWithHandle'],
      ['rename', 'renameWithFlags'],
      ['poll', 'pollWithHandle'],
      ['read', 'readBuffer'],
      ['write', 'writeBuffer']
    ]) {
      if (ops[legacy] && ops[enhanced]) {
        throw new TypeError(`Operations ${JSON.stringify(legacy)} and ${JSON.stringify(enhanced)} are mutually exclusive`)
      }
    }
    const utimensVariants = ['utimens', 'utimensWithTimespec', 'utimensWithHandle']
      .filter(name => ops[name] !== undefined)
    if (utimensVariants.length > 1) {
      throw new TypeError(`Operations ${utimensVariants.map(JSON.stringify).join(', ')} are mutually exclusive`)
    }
    if (opts.nullPathOk || opts.noPath) {
      const nullPathOption = opts.nullPathOk ? 'nullPathOk' : 'noPath'
      for (const [pathOnly, handleAware] of [
        ['getattr', 'fgetattr'],
        ['truncate', 'ftruncate'],
        ['chown', 'chownWithHandle'],
        ['chmod', 'chmodWithHandle'],
        ['utimens', 'utimensWithHandle'],
        ['utimensWithTimespec', 'utimensWithHandle']
      ]) {
        if (ops[pathOnly] && !ops[handleAware]) {
          throw new TypeError(
            `Option ${JSON.stringify(nullPathOption)} requires operation ${JSON.stringify(handleAware)} ` +
            `when ${JSON.stringify(pathOnly)} is implemented`
          )
        }
      }
    }

    const timeout = normalizeTimeoutOption(opts.timeout)
    this.opts = Object.freeze({
      ...opts,
      timeout: timeout && typeof timeout === 'object'
        ? Object.freeze({ ...timeout })
        : timeout
    })
    this.mnt = path.resolve(mnt)
    this.ops = Object.freeze({ ...ops })
    this.timeout = this.opts.timeout
    this.maxConcurrency = this.opts.maxConcurrency === undefined
      ? DEFAULT_MAX_CONCURRENCY
      : boundedInteger('maxConcurrency', this.opts.maxConcurrency, 1, MAX_MAX_CONCURRENCY)
    this._operationFlags =
      (this.opts.nullPathOk ? OPERATION_FLAG_NULL_PATH_OK : 0) |
      (this.opts.noPath ? OPERATION_FLAG_NO_PATH : 0) |
      ((this.ops.utimensWithTimespec || this.ops.utimensWithHandle)
        ? OPERATION_FLAG_UTIME_OMIT_OK
        : 0) |
      (this.opts.directIo ? OPERATION_FLAG_DIRECT_IO : 0) |
      (this.ops.pollWithHandle ? OPERATION_FLAG_POLL_HANDLE : 0)

    this._force = !!this.opts.force
    this._mkdir = !!this.opts.mkdir
    this._thread = null
    this._mountpointDev = null
    this._nativeMounted = false
    this._nativeMountPending = false
    this._startupTimer = null
    this._tearingDown = false
    this._teardownCallbacks = []
    this._pendingSignals = new Set()
    this._handlers = this._makeHandlerArray()

    const implemented = [binding.op_init, binding.op_getattr]
    if (this.ops) {
      for (const [name, { op }] of OpcodesAndDefaults) {
        if (this.ops[name] && this._handlers[op]) implemented.push(op)
      }
      for (const [name, op] of ENHANCED_OPERATIONS) {
        if (this.ops[name] && this._handlers[op]) implemented.push(op)
      }
    }
    this._implemented = new Set(implemented)

    // Used to determine if the user-defined callback needs to be nextTick'd.
    this._sync = true
  }

  _getImplementedArray () {
    const implemented = new Uint32Array(OpcodesAndDefaults.size)
    for (const impl of this._implemented) {
      implemented[impl] = 1
    }
    return implemented
  }

  _fuseOptions () {
    const options = []
    const hasValue = name => this.opts[name] !== undefined && this.opts[name] !== null

    if ((/\*|(?:^|,)fuse-(?:bindings|napi)(?:,|$)/.test(process.env.DEBUG || '')) || this.opts.debug) options.push('debug')
    if (this.opts.allowOther) options.push('allow_other')
    if (this.opts.allowRoot) options.push('allow_root')
    if (this.opts.autoUnmount) options.push('auto_unmount')
    if (this.opts.defaultPermissions) options.push('default_permissions')
    if (this.opts.blkdev) options.push('blkdev')
    if (hasValue('blksize')) options.push('blksize=' + mountInteger('blksize', this.opts.blksize))
    if (hasValue('maxRead')) options.push('max_read=' + mountInteger('maxRead', this.opts.maxRead))
    if (this.opts.fsname) options.push('fsname=' + mountString('fsname', this.opts.fsname))
    if (this.opts.subtype) options.push('subtype=' + mountString('subtype', this.opts.subtype))
    if (this.opts.kernelCache) options.push('kernel_cache')
    if (this.opts.autoCache) options.push('auto_cache')
    if (hasValue('umask')) options.push('umask=' + mountInteger('umask', this.opts.umask))
    if (hasValue('uid')) options.push('uid=' + mountInteger('uid', this.opts.uid))
    if (hasValue('gid')) options.push('gid=' + mountInteger('gid', this.opts.gid))
    if (hasValue('entryTimeout')) options.push('entry_timeout=' + mountNumber('entryTimeout', this.opts.entryTimeout))
    if (hasValue('attrTimeout')) options.push('attr_timeout=' + mountNumber('attrTimeout', this.opts.attrTimeout))
    if (hasValue('acAttrTimeout')) options.push('ac_attr_timeout=' + mountNumber('acAttrTimeout', this.opts.acAttrTimeout))
    if (this.opts.noforget) options.push('noforget')
    if (hasValue('remember')) options.push('remember=' + mountInteger('remember', this.opts.remember))
    if (this.opts.modules) options.push('modules=' + mountString('modules', this.opts.modules))

    if (this.opts.displayFolder && IS_OSX) { // only works on osx
      options.push('volname=' + mountString('name', path.basename(this.opts.name || this.mnt)))
      if (HAS_FOLDER_ICON) options.push('volicon=' + OSX_FOLDER_ICON)
    }

    return options.length ? '-o' + options.join(',') : ''
  }

  _makeHandlerArray () {
    const self = this
    const handlers = new Array(OpcodesAndDefaults.size)

    for (const [name, { op, defaults, nativeName }] of OpcodesAndDefaults) {
      const internalName = nativeName || name
      const nativeSignal = binding[`fuse_native_signal_${internalName}`]
      if (!nativeSignal) continue

      handlers[op] = makeHandler(name, internalName, op, defaults, nativeSignal)
    }

    return handlers

    function makeHandler (name, internalName, op, defaults, nativeSignal) {
      const to = operationTimeout(self.timeout, name)

      return function (nativeHandler, opCode, ...args) {
        const context = extractRequestContext(args)
        const sig = signal.bind(null, nativeHandler, context)
        const input = [...args]
        if (context) activeRequestContexts.add(context)
        const boundSignal = onceSignal(sig, input, context)
        const funcName = `_op_${internalName}`
        if (!self[funcName] || !self._implemented.has(op)) return boundSignal(Fuse.ENOSYS, ...defaults)
        try {
          const result = requestContexts.run(context, () => {
            return self[funcName].apply(self, [boundSignal, ...args])
          })
          if (result && typeof result.then === 'function') {
            result.catch(err => failOperation(err, boundSignal, input))
          }
          return result
        } catch (err) {
          return failOperation(err, boundSignal, input)
        }
      }

      function signal (nativeHandler, context, result, ...args) {
        result = normalizeResult(result, name)
        var arr = [nativeHandler, result, ...args]

        if (defaults) {
          while (arr.length > 2 && arr[arr.length - 1] === undefined) arr.pop()
          if (arr.length === 2) arr = arr.concat(defaults)
        }

        return process.nextTick(() => {
          try {
            nativeSignal(...arr)
          } finally {
            if (context) activeRequestContexts.delete(context)
          }
        })
      }

      function onceSignal (cb, input, context) {
        let called = false
        const timeout = to ? setTimeout(signalOnce, to, Fuse.ETIMEDOUT) : null
        signalOnce.cancel = () => failSignal(Fuse.EIO)
        signalOnce.operation = name
        self._pendingSignals.add(signalOnce)
        return signalOnce

        function signalOnce (err, ...args) {
          if (called) return
          called = true
          self._pendingSignals.delete(signalOnce)
          if (timeout) clearTimeout(timeout)

          cb(err, ...args)
        }

        function failSignal (err) {
          return signalOnce(err)
        }
      }

      function failOperation (err, cb, input) {
        self._reportOperationError(err, name, input)
        if (name === 'init') {
          const initError = err instanceof Error ? err : new Error(String(err))
          if (!initError.code) initError.code = 'EFUSEINIT'
          self._failOpen(initError)
        }
        return cb(Fuse.EIO)
      }
    }
  }

  // Static methods

  static unmount (mnt, cb) {
    if (typeof cb !== 'function') cb = () => {}
    if (typeof mnt !== 'string' || mnt.length === 0 || mnt.includes('\0')) {
      return process.nextTick(cb, new TypeError('Mountpoint must be a non-empty, NUL-free string'))
    }

    const command = IS_OSX ? 'diskutil' : 'fusermount3'
    const args = IS_OSX ? ['unmount', 'force', mnt] : ['-uz', '--', mnt]
    execFile(command, args, {
      shell: false,
      timeout: DEFAULT_TIMEOUT,
      killSignal: 'SIGKILL',
      env: createUnmountHelperEnvironment()
    }, (helperError, stdout, stderr) => {
      if (helperError) {
        if (typeof stdout === 'string' && stdout.length > 0) helperError.stdout = stdout
        if (typeof stderr === 'string' && stderr.length > 0) helperError.stderr = stderr
      }
      return waitForUnmountedMountpoint(mnt, observationError => {
        if (!observationError) return cb(null)
        if (!helperError) return cb(observationError)
        return cb(createUnmountError(mnt, command, helperError, observationError))
      })
    })
  }

  // Debugging methods

  // Lifecycle methods

  _open (cb) {
    const self = this

    if (this._force) {
      return fs.stat(path.join(this.mnt, 'test'), (err, st) => {
        if (isDisconnectedError(err)) {
          return Fuse.unmount(this.mnt, err => {
            if (err) return cb(err)
            return open()
          })
        }
        return open()
      })
    }
    return open()

    function open () {
      if (self._nativeMountPending) {
        const err = new Error('A previous native FUSE mount cancellation is still pending')
        err.code = 'EFUSEMOUNTBUSY'
        return process.nextTick(cb, err)
      }
      self._openCallback = cb
      return Fuse.checkEnvironment(self.opts, err => {
        if (err) return self._completeOpen(err)
        return beginOpen()
      })

      function beginOpen () {
        self._thread = Buffer.alloc(binding.sizeof_fuse_thread_t)

        let opts
        let implemented
        try {
          opts = self._fuseOptions()
          implemented = self._getImplementedArray()
        } catch (err) {
          return self._completeOpen(err)
        }

        return fs.stat(self.mnt, (err, stat) => {
          if (err && err.code !== 'ENOENT') return self._completeOpen(err)
          if (err) {
            if (!self._mkdir) return self._completeOpen(new Error('Mountpoint does not exist'))
            return fs.mkdir(self.mnt, { recursive: true }, err => {
              if (err) return self._completeOpen(err)
              fs.stat(self.mnt, (err, stat) => {
                if (err) return self._completeOpen(err)
                return onexists(stat)
              })
            })
          }
          if (!stat.isDirectory()) return self._completeOpen(new Error('Mountpoint is not a directory'))
          return onexists(stat)
        })

        function onexists (stat) {
          fs.stat(path.join(self.mnt, '..'), (parentErr, parent) => {
            if (parentErr) return self._completeOpen(parentErr)
            if (parent.dev !== stat.dev) return self._completeOpen(new Error('Mountpoint in use'))
            self._mountpointDev = stat.dev
            self._startMountTimer()
            self._nativeMountPending = true
            try {
              binding.fuse_native_mount(
                self.mnt,
                opts,
                self._thread,
                self,
                self._handlers,
                implemented,
                self.maxConcurrency,
                self._operationFlags,
                self._nativeLoopExited.bind(self),
                self._nativeMountComplete.bind(self),
                self.opts.maxRead !== undefined && self.opts.maxRead !== null,
                self.opts.maxRead === undefined || self.opts.maxRead === null
                  ? 0
                  : self.opts.maxRead
              )
            } catch (err) {
              self._nativeMountPending = false
              return self._completeOpen(err)
            }
          })
        }
      }
    }
  }

  _close (cb) {
    this._teardown(null, cb)
  }

  _nativeMountComplete (err) {
    this._nativeMountPending = false
    if (!this._openCallback) {
      this._thread = null
      return
    }
    if (err) return this._completeOpen(err)
    this._nativeMounted = true
  }

  _nativeLoopExited (nativeResult) {
    if (this._tearingDown || !this._nativeMounted) return
    const err = new Error(nativeResult < 0
      ? `The FUSE request loop terminated unexpectedly with native result ${nativeResult}`
      : 'The FUSE request loop terminated unexpectedly')
    err.code = 'EFUSELOOPEXIT'
    err.nativeResult = nativeResult

    if (this._openCallback) return this._failOpen(err)
    this._reportOperationError(err, 'lifecycle', [])
    this.close(closeError => {
      if (closeError) this._reportOperationError(closeError, 'cleanup', [])
    })
  }

  // Handlers

  _op_init (
    signal,
    protoMajor,
    protoMinor,
    asyncRead,
    maxWrite,
    maxReadahead,
    capable,
    want,
    maxBackground,
    congestionThreshold,
    maxRead
  ) {
    const connection = Object.freeze({
      protoMajor,
      protoMinor,
      asyncRead: asyncRead !== 0,
      maxWrite,
      maxReadahead,
      capable,
      want,
      maxBackground,
      congestionThreshold,
      maxRead
    })
    const complete = (err, requested) => {
      if (err) {
        signal(err)
        const initError = new Error(`FUSE init failed with result ${err}`)
        initError.code = 'EFUSEINIT'
        this._failOpen(initError)
        return
      }

      let config
      try {
        config = getInitConfigArray(connection, requested)
      } catch (err) {
        this._reportOperationError(err, 'init', [connection, requested])
        signal(Fuse.EIO)
        const initError = err instanceof Error ? err : new Error(String(err))
        initError.code = 'EFUSEINIT'
        this._failOpen(initError)
        return
      }

      signal(0, config)
      this._waitForMount()
    }

    if (this.ops.initWithConfig) return this.ops.initWithConfig(connection, complete)
    if (this.ops.init) return this.ops.init(err => complete(err))
    return complete(0)
  }

  _completeOpen (err) {
    if (!this._openCallback) return
    this._clearMountTimer()
    if (err && !this._nativeMounted) this._thread = null
    const cb = this._openCallback
    this._openCallback = null
    process.nextTick(cb, err)
  }

  _startMountTimer () {
    if (this._startupTimer) return
    const timeout = mountTimeout(this.timeout)
    if (!timeout) return
    this._startupTimer = setTimeout(() => {
      const err = new Error(IS_OSX
        ? `Timed out waiting for macFUSE to mount ${JSON.stringify(this.mnt)}. ` +
          'Ensure macFUSE is installed and enabled in Privacy & Security, ' +
          'then restart macOS if requested. See https://macfuse.github.io/.'
        : `Timed out waiting for FUSE to mount ${JSON.stringify(this.mnt)}`)
      err.code = IS_OSX ? 'EMACFUSEMOUNT' : 'EFUSEMOUNTTIMEOUT'
      this._failOpen(err)
    }, timeout)
  }

  _clearMountTimer () {
    if (!this._startupTimer) return
    clearTimeout(this._startupTimer)
    this._startupTimer = null
  }

  _failOpen (err) {
    if (!this._openCallback) return
    this._clearMountTimer()
    if (this._nativeMountPending) {
      try {
        binding.fuse_native_cancel_mount(this._thread)
      } catch (cancelError) {
        this._reportOperationError(cancelError, 'mount-cancel', [this.mnt])
      }
      return this._completeOpen(err)
    }
    if (!this._nativeMounted) return this._completeOpen(err)
    this._teardown(err, cleanupErr => this._completeOpen(cleanupErr || err))
  }

  _teardown (primaryError, cb) {
    if (typeof cb !== 'function') cb = () => {}
    this._teardownCallbacks.push({ primaryError, cb })
    if (this._tearingDown) return
    this._tearingDown = true

    const finish = (nativeError, unmountError) => {
      this._clearMountTimer()
      this._tearingDown = false

      const cleanupComplete = !nativeError || nativeError.cleanupComplete === true
      if (cleanupComplete) {
        this._nativeMounted = false
        this._thread = null
      }
      if (unmountError) {
        this._reportOperationError(unmountError, 'unmount', [this.mnt])
      }
      if (nativeError && unmountError && !nativeError.unmountError) {
        nativeError.unmountError = unmountError
      }

      const callbacks = this._teardownCallbacks
      this._teardownCallbacks = []
      if (nativeError && callbacks.some(entry => entry.primaryError)) {
        this._reportOperationError(nativeError, 'cleanup', [this.mnt])
      }
      for (const entry of callbacks) {
        const err = entry.primaryError || nativeError || null
        process.nextTick(entry.cb, err)
      }
    }

    if (!this._nativeMounted || !this._thread) return finish(null, null)

    const cancelPending = () => {
      for (const signal of [...this._pendingSignals]) {
        if (signal.operation !== 'destroy') signal.cancel()
      }
    }
    cancelPending()

    /*
     * The native teardown owns the complete FUSE 3 lifecycle: stop and join
     * the request loop, call fuse_unmount() once, then call fuse_destroy().
     * Linux must not run a second fusermount helper before that lifecycle.
     * macFUSE, however, requires a force-detach to wake its blocking receive
     * before the native request threads can be joined.
     */
    const beginNativeCleanup = (unmountError) => {
      cancelPending()
      try {
        binding.fuse_native_unmount(this._thread, nativeError => {
          finish(nativeError || null, unmountError || null)
        })
      } catch (nativeError) {
        finish(nativeError, unmountError || null)
      }
    }

    if (!IS_OSX) return beginNativeCleanup(null)
    Fuse.unmount(this.mnt, unmountError => {
      if (unmountError) unmountError.unmountFailure = true
      beginNativeCleanup(unmountError || null)
    })
  }

  _reportOperationError (err, operation, args) {
    if (this.opts.onError) {
      try {
        this.opts.onError(err, operation, args)
        return
      } catch (onErrorErr) {
        process.emitWarning(onErrorErr)
      }
    }
    process.emitWarning(err instanceof Error ? err : new Error(String(err)), {
      code: 'FUSE_OPERATION_ERROR',
      detail: `Operation: ${operation}`
    })
  }

  _respond (signal, operation, failureArgs, fn) {
    try {
      return fn()
    } catch (err) {
      this._reportOperationError(err, operation, [])
      return signal(Fuse.EIO, ...failureArgs)
    }
  }

  _waitForMount () {
    const self = this
    if (!this._startupTimer) this._startMountTimer()

    check()

    function check () {
      fs.stat(self.mnt, (err, stat) => {
        if (!err && stat.dev !== self._mountpointDev) {
          self._completeOpen(null)
          return
        }

        if (self._openCallback) setTimeout(check, 10)
      })
    }
  }

  _op_error (signal) {
    if (!this.ops.error) {
      signal(0)
      return
    }
    return this.ops.error(err => {
      return signal(err)
    })
  }

  _op_statfs (signal, path) {
    return this.ops.statfs(path, (err, statfs) => {
      if (err) return signal(err)
      return this._respond(signal, 'statfs', [], () => signal(0, getStatfsArray(statfs)))
    })
  }

  _op_getattr (signal, path) {
    if (!this.ops.getattr) {
      if (path !== '/') {
        signal(Fuse.EPERM)
      } else {
        signal(0, getStatArray({ mtime: new Date(0), atime: new Date(0), ctime: new Date(0), mode: 16877, size: 4096 }))
      }
      return
    }

    return this.ops.getattr(path, (err, stat) => {
      if (err) return signal(err, getStatArray())
      return this._respond(signal, 'getattr', [], () => signal(0, getStatArray(stat)))
    })
  }

  _op_fgetattr (signal, path, fd) {
    if (!this.ops.fgetattr) {
      if (path !== '/') {
        signal(Fuse.EPERM)
      } else {
        signal(0, getStatArray({ mtime: new Date(0), atime: new Date(0), ctime: new Date(0), mode: 16877, size: 4096 }))
      }
      return
    }
    return this.ops.fgetattr(path, fd, (err, stat) => {
      if (err) return signal(err)
      return this._respond(signal, 'fgetattr', [], () => signal(0, getStatArray(stat)))
    })
  }

  _op_access (signal, path, mode) {
    return this.ops.access(path, mode, err => {
      return signal(err)
    })
  }

  _op_open (signal, path, flags) {
    return this.ops.open(path, flags, (err, result) => {
      if (err) return signal(err)
      return this._respond(signal, 'open', [], () => signal(0, ...normalizeOpenResult(result)))
    })
  }

  _op_opendir (signal, path, flags) {
    return this.ops.opendir(path, flags, (err, result) => {
      if (err) return signal(err)
      return this._respond(signal, 'opendir', [], () => signal(0, ...normalizeOpenResult(result)))
    })
  }

  _op_create (signal, path, mode, flags) {
    const complete = (err, result) => {
      if (err) return signal(err)
      return this._respond(signal, 'create', [], () => signal(0, ...normalizeOpenResult(result)))
    }
    if (this.ops.createWithFlags) return this.ops.createWithFlags(path, mode, flags, complete)
    return this.ops.create(path, mode, complete)
  }

  _op_utimens (
    signal,
    path,
    atimeSecondsLow,
    atimeSecondsHigh,
    atimeNanoseconds,
    mtimeSecondsLow,
    mtimeSecondsHigh,
    mtimeNanoseconds,
    fd
  ) {
    const atime = decodeTimespec(atimeSecondsLow, atimeSecondsHigh, atimeNanoseconds)
    const mtime = decodeTimespec(mtimeSecondsLow, mtimeSecondsHigh, mtimeNanoseconds)
    const complete = err => {
      return signal(err)
    }
    if (this.ops.utimensWithTimespec) {
      return this.ops.utimensWithTimespec(path, atime, mtime, complete)
    }
    if (this.ops.utimensWithHandle) {
      return this.ops.utimensWithHandle(path, fd, atime, mtime, complete)
    }
    if (atime.nanoseconds === UTIME_NOW || atime.nanoseconds === UTIME_OMIT ||
        mtime.nanoseconds === UTIME_NOW || mtime.nanoseconds === UTIME_OMIT) {
      return signal(Fuse.EOPNOTSUPP)
    }
    return this.ops.utimens(
      path,
      timespecToMilliseconds(atime),
      timespecToMilliseconds(mtime),
      complete
    )
  }

  _op_release (signal, path, fd) {
    return this.ops.release(path, fd, err => {
      return signal(err)
    })
  }

  _op_releasedir (signal, path, fd) {
    return this.ops.releasedir(path, fd, err => {
      return signal(err)
    })
  }

  _op_read (signal, path, fd, buf, len, offsetLow, offsetHigh) {
    return this.ops.read(path, fd, buf, len, getSignedDoubleArg(offsetLow, offsetHigh), result => {
      return this._respond(signal, 'read', [buf], () => {
        return signal(normalizeIOResult(result, len), buf)
      })
    })
  }

  _op_write (signal, path, fd, buf, len, offsetLow, offsetHigh) {
    return this.ops.write(path, fd, buf, len, getSignedDoubleArg(offsetLow, offsetHigh), result => {
      return this._respond(signal, 'write', [], () => {
        return signal(normalizeIOResult(result, len))
      })
    })
  }

  _op_readdir (signal, path, fd, offsetLow, offsetHigh) {
    const paged = !!this.ops.readdirPaged
    const complete = (err, names, stats, nextOffsets) => {
      if (err) return signal(err)
      return this._respond(signal, 'readdir', [], () => {
        if (!Array.isArray(names) || !names.every(isValidDirectoryEntry)) {
          throw new TypeError('readdir names must be valid NUL-free entry names of at most 255 UTF-8 bytes')
        }
        if (stats !== undefined && !Array.isArray(stats)) {
          throw new TypeError('readdir stats must be an array')
        }
        if (stats && stats.length !== 0 && stats.length !== names.length) {
          throw new RangeError('readdir stats must be empty or align with names')
        }
        if (stats) stats = stats.map(getStatArray)
        const offsets = paged ? getReaddirOffsetsArray(nextOffsets, names.length) : new Uint32Array(0)
        return signal(0, names, stats || [], offsets)
      })
    }
    if (paged) {
      const offset = getSignedDoubleArg(offsetLow, offsetHigh)
      return this.ops.readdirPaged(path, fd, offset, complete)
    }
    return this.ops.readdir(path, complete)
  }

  _op_setxattr (signal, path, name, value, position, flags) {
    return this.ops.setxattr(path, name, value, position, flags, err => {
      return signal(err)
    })
  }

  _op_getxattr (signal, path, name, valueBuf, position) {
    return this.ops.getxattr(path, name, position, (err, value) => {
      if (err) return signal(err)
      return this._respond(signal, 'getxattr', [valueBuf], () => {
        if (value === null || value === undefined) return signal(XATTR_NOT_FOUND)
        if (!Buffer.isBuffer(value)) throw new TypeError('getxattr value must be a Buffer or null')
        if (valueBuf.length === 0) return signal(value.length, valueBuf)
        if (value.length > valueBuf.length) return signal(Fuse.ERANGE)
        value.copy(valueBuf)
        return signal(value.length, valueBuf)
      })
    })
  }

  _op_listxattr (signal, path, listBuf) {
    return this.ops.listxattr(path, (err, list) => {
      if (err) return signal(err)
      return this._respond(signal, 'listxattr', [listBuf], () => {
        if (!Array.isArray(list) || !list.every(name => typeof name === 'string' && !name.includes('\0'))) {
          throw new TypeError('listxattr result must be an array of NUL-free strings')
        }

        const size = list.reduce((total, name) => total + Buffer.byteLength(name) + 1, 0)
        if (listBuf.length === 0) return signal(size, listBuf)
        if (size > listBuf.length) return signal(Fuse.ERANGE)

        let ptr = 0
        for (const name of list) {
          ptr += listBuf.write(name, ptr, Buffer.byteLength(name), 'utf8')
          listBuf[ptr++] = 0
        }

        return signal(ptr, listBuf)
      })
    })
  }

  _op_removexattr (signal, path, name) {
    return this.ops.removexattr(path, name, err => {
      return signal(err)
    })
  }

  _op_flush (signal, path, fd) {
    return this.ops.flush(path, fd, err => {
      return signal(err)
    })
  }

  _op_fsync (signal, path, datasync, fd) {
    return this.ops.fsync(path, datasync !== 0, fd, err => {
      return signal(err)
    })
  }

  _op_fsyncdir (signal, path, datasync, fd) {
    return this.ops.fsyncdir(path, datasync !== 0, fd, err => {
      return signal(err)
    })
  }

  _op_truncate (signal, path, sizeLow, sizeHigh) {
    const size = getSignedDoubleArg(sizeLow, sizeHigh)
    return this.ops.truncate(path, size, err => {
      return signal(err)
    })
  }

  _op_ftruncate (signal, path, fd, sizeLow, sizeHigh) {
    const size = getSignedDoubleArg(sizeLow, sizeHigh)
    return this.ops.ftruncate(path, fd, size, err => {
      return signal(err)
    })
  }

  _op_readlink (signal, path) {
    return this.ops.readlink(path, (err, linkname) => {
      if (err) return signal(err)
      return this._respond(signal, 'readlink', [], () => {
        if (typeof linkname !== 'string' || linkname.includes('\0')) {
          throw new TypeError('readlink result must be a NUL-free string')
        }
        return signal(0, linkname)
      })
    })
  }

  _op_chown (signal, path, uid, gid, fd) {
    if (this.ops.chownWithHandle) {
      return this.ops.chownWithHandle(path, fd, uid, gid, err => signal(err))
    }
    return this.ops.chown(path, uid, gid, err => {
      return signal(err)
    })
  }

  _op_chmod (signal, path, mode, fd) {
    if (this.ops.chmodWithHandle) {
      return this.ops.chmodWithHandle(path, fd, mode, err => signal(err))
    }
    return this.ops.chmod(path, mode, err => {
      return signal(err)
    })
  }

  _op_mknod (signal, path, mode, dev) {
    return this.ops.mknod(path, mode, dev, err => {
      return signal(err)
    })
  }

  _op_unlink (signal, path) {
    return this.ops.unlink(path, err => {
      return signal(err)
    })
  }

  _op_rename (signal, src, dest, flags) {
    if (this.ops.renameWithFlags) {
      return this.ops.renameWithFlags(src, dest, flags, err => signal(err))
    }
    if (flags !== 0) return signal(Fuse.EOPNOTSUPP)
    return this.ops.rename(src, dest, err => {
      return signal(err)
    })
  }

  _op_link (signal, src, dest) {
    return this.ops.link(src, dest, err => {
      return signal(err)
    })
  }

  _op_symlink (signal, src, dest) {
    return this.ops.symlink(src, dest, err => {
      return signal(err)
    })
  }

  _op_mkdir (signal, path, mode) {
    return this.ops.mkdir(path, mode, err => {
      return signal(err)
    })
  }

  _op_rmdir (signal, path) {
    return this.ops.rmdir(path, err => {
      return signal(err)
    })
  }

  _op_destroy (signal) {
    return this.ops.destroy(err => signal(err))
  }

  _op_lock (
    signal,
    path,
    fd,
    command,
    type,
    whence,
    startLow,
    startHigh,
    lengthLow,
    lengthHigh,
    pid
  ) {
    const lock = Object.freeze({
      type,
      whence,
      start: getSignedDoubleArg(startLow, startHigh),
      length: getSignedDoubleArg(lengthLow, lengthHigh),
      pid
    })
    return this.ops.lock(path, fd, command, lock, (err, result) => {
      if (err) return signal(err)
      return this._respond(signal, 'lock', [], () => signal(0, encodeLock(result || lock)))
    })
  }

  _op_bmap (signal, path, blockSize, index) {
    return this.ops.bmap(path, blockSize, index, (err, result) => {
      if (err) return signal(err)
      return this._respond(signal, 'bmap', [], () => {
        return signal(0, toUint64Value(result ?? index, 'bmap index'))
      })
    })
  }

  _op_ioctl (signal, path, fd, command, argument, flags, data) {
    return this.ops.ioctl(path, fd, command, argument, flags, data, (err, output) => {
      if (err) return signal(err)
      return this._respond(signal, 'ioctl', [data], () => {
        if (output === undefined || output === null) output = data
        if (!Buffer.isBuffer(output) || output.length !== data.length) {
          throw new RangeError('ioctl output must be a Buffer with the same length as its input')
        }
        return signal(0, output)
      })
    })
  }

  _op_poll (signal, path, fd, pollId) {
    const pollHandle = this.ops.pollWithHandle && pollId
      ? new PollHandle(this._thread, pollId)
      : null
    const complete = (err, events) => {
      if (err && pollHandle) pollHandle.close()
      if (err) return signal(err)
      return this._respond(signal, 'poll', [], () => {
        return signal(0, toUint32(events ?? 0, 'poll events'))
      })
    }
    if (this.ops.pollWithHandle) {
      return this.ops.pollWithHandle(path, fd, pollHandle, complete)
    }
    return this.ops.poll(path, fd, complete)
  }

  _op_write_buf (signal, path, fd, buffer, length, offsetLow, offsetHigh) {
    return this.ops.writeBuffer(
      path,
      fd,
      buffer,
      length,
      getSignedDoubleArg(offsetLow, offsetHigh),
      result => {
        return this._respond(signal, 'writeBuffer', [], () => {
          return signal(normalizeIOResult(result, length))
        })
      }
    )
  }

  _op_read_buf (signal, path, fd, length, offsetLow, offsetHigh) {
    return this.ops.readBuffer(
      path,
      fd,
      length,
      getSignedDoubleArg(offsetLow, offsetHigh),
      (err, buffer) => {
        if (err) return signal(err)
        return this._respond(signal, 'readBuffer', [Buffer.alloc(0)], () => {
          if (!Buffer.isBuffer(buffer) || buffer.length > length) {
            throw new RangeError('readBuffer must return a Buffer no larger than the requested length')
          }
          return signal(0, buffer)
        })
      }
    )
  }

  _op_flock (signal, path, fd, operation) {
    return this.ops.flock(path, fd, operation, err => signal(err))
  }

  _op_fallocate (
    signal,
    path,
    fd,
    mode,
    offsetLow,
    offsetHigh,
    lengthLow,
    lengthHigh
  ) {
    return this.ops.fallocate(
      path,
      fd,
      mode,
      getSignedDoubleArg(offsetLow, offsetHigh),
      getSignedDoubleArg(lengthLow, lengthHigh),
      err => signal(err)
    )
  }

  _op_copy_file_range (
    signal,
    pathIn,
    fdIn,
    offsetInLow,
    offsetInHigh,
    pathOut,
    fdOut,
    offsetOutLow,
    offsetOutHigh,
    length,
    flags
  ) {
    return this.ops.copyFileRange(
      pathIn,
      fdIn,
      getSignedDoubleArg(offsetInLow, offsetInHigh),
      pathOut,
      fdOut,
      getSignedDoubleArg(offsetOutLow, offsetOutHigh),
      length,
      flags,
      result => {
        return this._respond(signal, 'copyFileRange', [], () => {
          if (typeof result === 'number' && result < 0) {
            return signal(normalizeResult(result, 'copyFileRange'), new Uint32Array(2))
          }
          const copied = toInt64(result, 'copyFileRange result')
          const requested = toUint64(length, 'copyFileRange length')
          if (copied < 0n || BigInt.asUintN(64, copied) > requested) {
            throw new RangeError('copyFileRange result must be between zero and the requested length')
          }
          return signal(0, encodeInt64(copied, 'copyFileRange result'))
        })
      }
    )
  }

  _op_lseek (signal, path, fd, offsetLow, offsetHigh, whence) {
    return this.ops.lseek(
      path,
      fd,
      getSignedDoubleArg(offsetLow, offsetHigh),
      whence,
      (err, offset) => {
        if (err) return signal(err, new Uint32Array(2))
        return this._respond(signal, 'lseek', [], () => {
          const result = toInt64(offset, 'lseek result')
          if (result < 0n) throw new RangeError('lseek result must not be negative')
          return signal(0, encodeInt64(result, 'lseek result'))
        })
      }
    )
  }

  // Public API

  mount (cb) {
    return this.open(cb)
  }

  unmount (cb) {
    return this.close(cb)
  }

  /**
   * Register an open file descriptor with the kernel for FUSE passthrough.
   * Returns a backing id (> 0) to hand back from open/create as
   * `{ fd, backingId }`, which takes this process out of the data path for
   * that handle.
   *
   * Throws with a .code of the errno name on failure. Callers are expected
   * to fall back to ordinary read/write rather than treat it as fatal.
   */
  backingOpen (fd) {
    if (!Number.isInteger(fd) || fd < 0) {
      throw new TypeError('backingOpen requires a file descriptor')
    }
    const result = binding.fuse_native_backing_open(this._thread, fd)
    if (result > 0) return result
    const err = new Error('Failed to register FUSE backing file')
    err.errno = result
    err.code = errnoName(-result)
    throw err
  }

  /** Release a backing id, on the last release of the file it belongs to. */
  backingClose (backingId) {
    if (!Number.isInteger(backingId) || backingId <= 0) {
      throw new TypeError('backingClose requires a backing id')
    }
    const result = binding.fuse_native_backing_close(this._thread, backingId)
    if (result === 0) return
    const err = new Error('Failed to release FUSE backing file')
    err.errno = result
    err.code = errnoName(-result)
    throw err
  }

  invalidateEntry (entryPath, cb) {
    if (typeof cb !== 'function') cb = () => {}

    if (activeRequestContexts.has(requestContexts.getStore())) {
      const err = new Error(
        'FUSE entry invalidation must run outside a filesystem operation callback'
      )
      err.code = 'EDEADLK'
      return process.nextTick(cb, err)
    }

    let normalized
    try {
      normalized = normalizeInvalidationPath(entryPath)
    } catch (err) {
      return process.nextTick(cb, err)
    }

    if (!this._nativeMounted || !this._thread) {
      const err = new Error('FUSE filesystem is not mounted')
      err.code = 'ENOTCONN'
      return process.nextTick(cb, err)
    }

    const thread = this._thread
    const name = path.posix.basename(normalized)
    const parentPath = path.posix.dirname(normalized)
    const notify = parent => {
      let called = false
      let synchronous = true
      const complete = result => {
        if (called) return
        called = true
        if (result === 0 || result === Fuse.ENOENT) return cb(null)
        const err = new Error(
          `Failed to invalidate FUSE entry ${JSON.stringify(normalized)}: native result ${result}`
        )
        err.code = invalidationErrorCode(result)
        err.errno = result
        cb(err)
      }
      const completed = result => {
        if (synchronous) return process.nextTick(complete, result)
        complete(result)
      }
      try {
        binding.fuse_native_invalidate_entry(thread, parent, name, completed)
      } catch (err) {
        called = true
        return process.nextTick(cb, err)
      } finally {
        synchronous = false
      }
    }

    if (parentPath === '/') return notify(1)
    const mountedParent = path.join(this.mnt, parentPath.slice(1))
    fs.stat(mountedParent, { bigint: true }, (err, stat) => {
      if (err) return cb(err)
      notify(stat.ino)
    })
  }

  context () {
    return requestContexts.getStore() || null
  }

  errno (code) {
    return (code && Fuse[code.toUpperCase()]) || -1
  }
}

Fuse.EPERM = -1
Fuse.ENOENT = -2
Fuse.ESRCH = -3
Fuse.EINTR = -4
Fuse.EIO = -5
Fuse.ENXIO = -6
Fuse.E2BIG = -7
Fuse.ENOEXEC = -8
Fuse.EBADF = -9
Fuse.ECHILD = -10
Fuse.EAGAIN = -11
Fuse.ENOMEM = -12
Fuse.EACCES = -13
Fuse.EFAULT = -14
Fuse.ENOTBLK = -15
Fuse.EBUSY = -16
Fuse.EEXIST = -17
Fuse.EXDEV = -18
Fuse.ENODEV = -19
Fuse.ENOTDIR = -20
Fuse.EISDIR = -21
Fuse.EINVAL = -22
Fuse.ENFILE = -23
Fuse.EMFILE = -24
Fuse.ENOTTY = -25
Fuse.ETXTBSY = -26
Fuse.EFBIG = -27
Fuse.ENOSPC = -28
Fuse.ESPIPE = -29
Fuse.EROFS = -30
Fuse.EMLINK = -31
Fuse.EPIPE = -32
Fuse.EDOM = -33
Fuse.ERANGE = -34
Fuse.EDEADLK = -35
Fuse.ENAMETOOLONG = -36
Fuse.ENOLCK = -37
Fuse.ENOSYS = -38
Fuse.ENOTEMPTY = -39
Fuse.ELOOP = -40
Fuse.EWOULDBLOCK = -11
Fuse.ENOMSG = -42
Fuse.EIDRM = -43
Fuse.ECHRNG = -44
Fuse.EL2NSYNC = -45
Fuse.EL3HLT = -46
Fuse.EL3RST = -47
Fuse.ELNRNG = -48
Fuse.EUNATCH = -49
Fuse.ENOCSI = -50
Fuse.EL2HLT = -51
Fuse.EBADE = -52
Fuse.EBADR = -53
Fuse.EXFULL = -54
Fuse.ENOANO = -55
Fuse.EBADRQC = -56
Fuse.EBADSLT = -57
Fuse.EDEADLOCK = -35
Fuse.EBFONT = -59
Fuse.ENOSTR = -60
Fuse.ENODATA = -61
Fuse.ETIME = -62
Fuse.ENOSR = -63
Fuse.ENONET = -64
Fuse.ENOPKG = -65
Fuse.EREMOTE = -66
Fuse.ENOLINK = -67
Fuse.EADV = -68
Fuse.ESRMNT = -69
Fuse.ECOMM = -70
Fuse.EPROTO = -71
Fuse.EMULTIHOP = -72
Fuse.EDOTDOT = -73
Fuse.EBADMSG = -74
Fuse.EOVERFLOW = -75
Fuse.ENOTUNIQ = -76
Fuse.EBADFD = -77
Fuse.EREMCHG = -78
Fuse.ELIBACC = -79
Fuse.ELIBBAD = -80
Fuse.ELIBSCN = -81
Fuse.ELIBMAX = -82
Fuse.ELIBEXEC = -83
Fuse.EILSEQ = -84
Fuse.ERESTART = -85
Fuse.ESTRPIPE = -86
Fuse.EUSERS = -87
Fuse.ENOTSOCK = -88
Fuse.EDESTADDRREQ = -89
Fuse.EMSGSIZE = -90
Fuse.EPROTOTYPE = -91
Fuse.ENOPROTOOPT = -92
/*
 * FUSE capability bits, as exposed to init(). Only the ones computerd
 * negotiates are listed; the full set lives in fuse_common.h.
 */
Fuse.CAP_PASSTHROUGH = 1 << 29
Fuse.CAP_ASYNC_READ = 1 << 0

Fuse.EPROTONOSUPPORT = -93
Fuse.ESOCKTNOSUPPORT = -94
Fuse.EOPNOTSUPP = -95
Fuse.ENOTSUP = -95
Fuse.EPFNOSUPPORT = -96
Fuse.EAFNOSUPPORT = -97
Fuse.EADDRINUSE = -98
Fuse.EADDRNOTAVAIL = -99
Fuse.ENETDOWN = -100
Fuse.ENETUNREACH = -101
Fuse.ENETRESET = -102
Fuse.ECONNABORTED = -103
Fuse.ECONNRESET = -104
Fuse.ENOBUFS = -105
Fuse.EISCONN = -106
Fuse.ENOTCONN = -107
Fuse.ESHUTDOWN = -108
Fuse.ETOOMANYREFS = -109
Fuse.ETIMEDOUT = -110
Fuse.ECONNREFUSED = -111
Fuse.EHOSTDOWN = -112
Fuse.EHOSTUNREACH = -113
Fuse.EALREADY = -114
Fuse.EINPROGRESS = -115
Fuse.ESTALE = -116
Fuse.EUCLEAN = -117
Fuse.ENOTNAM = -118
Fuse.ENAVAIL = -119
Fuse.EISNAM = -120
Fuse.EREMOTEIO = -121
Fuse.EDQUOT = -122
Fuse.ENOMEDIUM = -123
Fuse.EMEDIUMTYPE = -124
Fuse.UTIME_NOW = UTIME_NOW
Fuse.UTIME_OMIT = UTIME_OMIT

for (const [name, value] of Object.entries(os.constants.errno)) {
  Fuse[name] = -value
}

module.exports = Fuse

function mountTimeout (timeout) {
  if (typeof timeout !== 'object' || !timeout) return timeout
  return operationTimeout(timeout, 'init')
}

function operationTimeout (timeout, operation) {
  if (typeof timeout !== 'object' || !timeout) return timeout
  const hasOperation = Object.prototype.hasOwnProperty.call(timeout, operation)
  const hasDefault = Object.prototype.hasOwnProperty.call(timeout, 'default')
  const value = hasOperation ? timeout[operation] : (hasDefault ? timeout.default : DEFAULT_TIMEOUT)
  return value === false ? 0 : value
}

function isValidDirectoryEntry (name) {
  return typeof name === 'string' &&
    name.length > 0 &&
    !name.includes('\0') &&
    !name.includes('/') &&
    Buffer.byteLength(name) <= 255
}

function getStatfsArray (statfs) {
  const ints = new Uint32Array(22)
  const values = [
    statfs && statfs.bsize,
    statfs && statfs.frsize,
    statfs && statfs.blocks,
    statfs && statfs.bfree,
    statfs && statfs.bavail,
    statfs && statfs.files,
    statfs && statfs.ffree,
    statfs && statfs.favail,
    statfs && statfs.fsid,
    statfs && statfs.flag,
    statfs && statfs.namemax
  ]
  const names = [
    'bsize', 'frsize', 'blocks', 'bfree', 'bavail', 'files',
    'ffree', 'favail', 'fsid', 'flag', 'namemax'
  ]
  for (let i = 0; i < values.length; i++) setUint64(ints, i * 2, values[i] ?? 0, `statfs.${names[i]}`)

  return ints
}

function setUint64 (arr, idx, value, name) {
  const num = toUint64(value, name)
  arr[idx] = Number(num & 0xffffffffn)
  arr[idx + 1] = Number(num >> 32n)
}

function setInt64 (arr, idx, value, name) {
  const num = toInt64(value, name)
  const bits = BigInt.asUintN(64, num)
  arr[idx] = Number(bits & 0xffffffffn)
  arr[idx + 1] = Number(bits >> 32n)
}

function getSignedDoubleArg (low, high) {
  const value = BigInt.asIntN(64, (BigInt(high) << 32n) | BigInt(low))
  if (value >= -MAX_SAFE_BIGINT && value <= MAX_SAFE_BIGINT) return Number(value)
  return value
}

function extractRequestContext (args) {
  const encoded = args[args.length - 1]
  if (!(encoded instanceof Uint32Array) || encoded.length !== 11) return null
  args.pop()
  const fileInfoFlags = encoded[6]
  const fileInfo = encoded[4] === 0
    ? null
    : Object.freeze({
        flags: encoded[5] | 0,
        writepage: (fileInfoFlags & 1) !== 0,
        directIO: (fileInfoFlags & 2) !== 0,
        keepCache: (fileInfoFlags & 4) !== 0,
        flush: (fileInfoFlags & 8) !== 0,
        nonseekable: (fileInfoFlags & 16) !== 0,
        flockRelease: (fileInfoFlags & 32) !== 0,
        fd: getUnsignedDoubleArg(encoded[7], encoded[8]),
        lockOwner: getUnsignedDoubleArg(encoded[9], encoded[10])
      })
  return Object.freeze({
    uid: encoded[0],
    gid: encoded[1],
    pid: encoded[2],
    umask: encoded[3],
    fileInfo
  })
}

function getUnsignedDoubleArg (low, high) {
  const value = (BigInt(high) << 32n) | BigInt(low)
  return value <= MAX_SAFE_BIGINT ? Number(value) : value
}

function decodeTimespec (secondsLow, secondsHigh, nanoseconds) {
  if (!Number.isInteger(nanoseconds) ||
      (nanoseconds > 999999999 && nanoseconds !== UTIME_NOW && nanoseconds !== UTIME_OMIT) ||
      nanoseconds < 0) {
    throw new RangeError('Native FUSE timespec nanoseconds are outside the valid range')
  }
  return Object.freeze({
    seconds: getSignedDoubleArg(secondsLow, secondsHigh),
    nanoseconds
  })
}

function timespecToMilliseconds (timespec) {
  if (timespec.nanoseconds === UTIME_NOW || timespec.nanoseconds === UTIME_OMIT) {
    throw new RangeError(
      'UTIME_NOW and UTIME_OMIT require utimensWithTimespec or utimensWithHandle'
    )
  }
  const seconds = typeof timespec.seconds === 'bigint'
    ? timespec.seconds
    : BigInt(timespec.seconds)
  const milliseconds = (seconds * 1000n) + BigInt(Math.trunc(timespec.nanoseconds / 1000000))
  return milliseconds >= -MAX_SAFE_BIGINT && milliseconds <= MAX_SAFE_BIGINT
    ? Number(milliseconds)
    : milliseconds
}

function normalizeTimespec (value, name) {
  if (value === undefined || value === null) {
    return { seconds: 0n, nanoseconds: 0 }
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`${name} must be a valid Date`)
    value = value.getTime()
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    const milliseconds = toInt64(value, `${name} milliseconds`)
    let seconds = milliseconds / 1000n
    let remainder = milliseconds % 1000n
    if (remainder < 0n) {
      seconds--
      remainder += 1000n
    }
    return {
      seconds,
      nanoseconds: Number(remainder) * 1000000
    }
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a Date, integer milliseconds, or a timespec object`)
  }
  for (const field of Reflect.ownKeys(value)) {
    if (field !== 'seconds' && field !== 'nanoseconds') {
      throw new TypeError(`Unknown ${name} property ${String(field)}`)
    }
  }
  const seconds = toInt64(value.seconds ?? 0, `${name}.seconds`)
  const nanoseconds = value.nanoseconds ?? 0
  if (!Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds > 999999999) {
    throw new RangeError(`${name}.nanoseconds must be an integer from 0 through 999999999`)
  }
  return { seconds, nanoseconds }
}

function setTimespec (arr, idx, value, name) {
  const timespec = normalizeTimespec(value, name)
  setInt64(arr, idx, timespec.seconds, `${name}.seconds`)
  arr[idx + 2] = timespec.nanoseconds
}

function getStatArray (stat) {
  const ints = new Uint32Array(26)

  ints[0] = toUint32(stat && stat.mode, 'stat.mode')
  ints[1] = toUint32(stat && stat.uid, 'stat.uid')
  ints[2] = toUint32(stat && stat.gid, 'stat.gid')
  setNonNegativeInt64(ints, 3, (stat && stat.size) ?? 0, 'stat.size')
  setUint64(ints, 5, (stat && stat.dev) ?? 0, 'stat.dev')
  setUint64(ints, 7, (stat && stat.nlink) ?? 1, 'stat.nlink')
  setUint64(ints, 9, (stat && stat.ino) ?? 0, 'stat.ino')
  setUint64(ints, 11, (stat && stat.rdev) ?? 0, 'stat.rdev')
  setUint64(ints, 13, (stat && stat.blksize) ?? 0, 'stat.blksize')
  setUint64(ints, 15, (stat && stat.blocks) ?? 0, 'stat.blocks')
  setTimespec(ints, 17, stat && stat.atime, 'stat.atime')
  setTimespec(ints, 20, stat && stat.mtime, 'stat.mtime')
  setTimespec(ints, 23, stat && stat.ctime, 'stat.ctime')

  return ints
}

function waitForUnmountedMountpoint (mnt, cb) {
  const deadline = Date.now() + DEFAULT_TIMEOUT
  const mountpoint = path.resolve(mnt)
  const parent = path.dirname(mountpoint)
  let lastError = null
  let stableChecks = 0

  check()

  function check () {
    fs.stat(mountpoint, (mountErr, mountStat) => {
      if (mountErr) {
        if (mountErr.code === 'ENOENT') return cb(null)
        stableChecks = 0
        if (isDisconnectedError(mountErr)) return retry(mountErr)
        return cb(mountErr)
      }

      fs.stat(parent, (parentErr, parentStat) => {
        if (parentErr) return cb(parentErr)
        if (mountStat.dev === parentStat.dev) {
          stableChecks++
          if (stableChecks >= UNMOUNT_STABILITY_CHECKS) return cb(null)
          return retry()
        }
        stableChecks = 0
        return retry()
      })
    })
  }

  function retry (cause) {
    if (cause) lastError = cause
    if (Date.now() < deadline) {
      return setTimeout(check, UNMOUNT_POLL_INTERVAL)
    }

    const err = new Error(`Timed out waiting for FUSE mount ${JSON.stringify(mountpoint)} to detach`)
    err.code = 'EFUSEUNMOUNTWAIT'
    if (lastError) err.cause = lastError
    return cb(err)
  }
}

function createUnmountHelperEnvironment () {
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (UNMOUNT_HELPER_UNSAFE_ENV_PREFIXES.some(prefix => name.startsWith(prefix))) continue
    env[name] = value
  }
  return env
}

function createUnmountError (mnt, command, helperError, observationError) {
  const mountpoint = path.resolve(mnt)
  const helperDetail = formatHelperError(helperError)
  const err = new Error(
    `${command} failed and FUSE mount ${JSON.stringify(mountpoint)} did not detach` +
    (helperDetail ? `: ${helperDetail}` : '')
  )
  err.code = 'EFUSEUNMOUNT'
  err.mountpoint = mountpoint
  err.command = command
  err.cause = helperError
  err.helperError = helperError
  err.observationError = observationError
  return err
}

function formatHelperError (err) {
  if (!err) return ''
  const detail = typeof err.stderr === 'string' && err.stderr.trim()
    ? err.stderr.trim()
    : typeof err.message === 'string'
      ? err.message.trim()
      : ''
  return detail.replace(/\s+/g, ' ').slice(0, 512)
}

function isDisconnectedError (err) {
  return !!err && (
    err.code === 'ENOTCONN' ||
    err.code === 'ENXIO' ||
    err.errno === Fuse.ENOTCONN ||
    err.errno === Fuse.ENXIO
  )
}

function normalizeInvalidationPath (entryPath) {
  if (typeof entryPath !== 'string' || entryPath.length === 0 || entryPath.includes('\0')) {
    throw new TypeError('FUSE entry path must be a non-empty NUL-free string')
  }
  if (!entryPath.startsWith('/')) {
    throw new TypeError('FUSE entry path must be absolute within the mounted filesystem')
  }
  const normalized = path.posix.normalize(entryPath)
  if (normalized === '/') throw new RangeError('The FUSE root entry cannot be invalidated')
  if (Buffer.byteLength(path.posix.basename(normalized)) > 255) {
    throw new RangeError('FUSE entry name must be at most 255 UTF-8 bytes')
  }
  return normalized
}

function invalidationErrorCode (result) {
  for (const [code, errno] of Object.entries(os.constants.errno)) {
    if (result === -errno) return code
  }
  return 'EFUSEINVALIDATE'
}

function normalizeTimeoutOption (timeout) {
  if (timeout === false) return 0
  if (timeout === undefined) return DEFAULT_TIMEOUT
  if (typeof timeout === 'number') return timeoutNumber('timeout', timeout)
  if (!timeout || typeof timeout !== 'object' || Array.isArray(timeout)) {
    throw new TypeError('timeout must be a non-negative number, false, or an object')
  }

  const normalized = {}
  for (const [name, value] of Object.entries(timeout)) {
    if (name !== 'default' && !OpcodesAndDefaults.has(name)) {
      throw new TypeError(`Unknown timeout operation ${JSON.stringify(name)}`)
    }
    if (value === false) {
      normalized[name] = false
    } else {
      normalized[name] = timeoutNumber(`timeout.${name}`, value)
    }
  }
  return normalized
}

function validateOptions (opts) {
  const booleanOptions = [
    'displayFolder', 'debug', 'force', 'mkdir', 'allowOther', 'allowRoot',
    'autoUnmount', 'defaultPermissions', 'blkdev', 'kernelCache', 'autoCache',
    'noforget', 'nonEmpty', 'nullPathOk', 'noPath', 'directIo'
  ]
  const numberOptions = ['entryTimeout', 'attrTimeout', 'acAttrTimeout']
  const stringOptions = ['fsname', 'subtype', 'modules', 'name']

  for (const name of Reflect.ownKeys(opts)) {
    if (typeof name !== 'string' || !KNOWN_OPTIONS.has(name)) {
      throw new TypeError(`Unknown FUSE option ${String(name)}`)
    }
  }

  for (const name of booleanOptions) {
    if (opts[name] !== undefined && typeof opts[name] !== 'boolean') {
      throw new TypeError(`${name} must be a boolean`)
    }
  }
  for (const name of ['uid', 'gid']) {
    if (opts[name] !== undefined && opts[name] !== null) boundedInteger(name, opts[name], 0, MAX_INT32)
  }
  for (const name of ['userId', 'blksize', 'maxRead']) {
    if (opts[name] !== undefined && opts[name] !== null) boundedInteger(name, opts[name], 0, 0xffffffff)
  }
  if (opts.fd !== undefined && opts.fd !== null) boundedInteger('fd', opts.fd, 0, MAX_INT32)
  if (opts.umask !== undefined && opts.umask !== null) boundedInteger('umask', opts.umask, 0, 0o7777)
  if (opts.remember !== undefined && opts.remember !== null) {
    boundedInteger('remember', opts.remember, 0, MAX_INT32)
  }
  if (opts.maxConcurrency !== undefined && opts.maxConcurrency !== null) {
    boundedInteger('maxConcurrency', opts.maxConcurrency, 1, MAX_MAX_CONCURRENCY)
  }
  for (const name of numberOptions) {
    if (opts[name] !== undefined && opts[name] !== null) mountNumber(name, opts[name])
  }
  for (const name of stringOptions) {
    if (opts[name] !== undefined && opts[name] !== null) mountString(name, opts[name])
  }
  if (opts.onError !== undefined && typeof opts.onError !== 'function') {
    throw new TypeError('onError must be a function')
  }
}

function normalizeAndValidateOptions (opts) {
  const normalized = normalizeOptionAliases(opts)
  validateOptions(normalized)
  validateFuse3Options(normalized)
  return normalized
}

function normalizeOptionAliases (opts) {
  let normalized = null

  for (const [alias, canonical] of OPTION_ALIASES) {
    if (!Object.prototype.hasOwnProperty.call(opts, alias)) continue

    const hasCanonical = Object.prototype.hasOwnProperty.call(opts, canonical)
    if (hasCanonical && opts[canonical] !== opts[alias]) {
      throw new TypeError(
        `FUSE options ${JSON.stringify(canonical)} and ${JSON.stringify(alias)} must not conflict`
      )
    }

    if (!normalized) normalized = { ...opts }
    if (!hasCanonical) normalized[canonical] = opts[alias]
    delete normalized[alias]
  }

  return normalized || opts
}

function validateOperations (ops) {
  for (const name of Reflect.ownKeys(ops)) {
    if (typeof name !== 'string' || !KNOWN_OPERATIONS.has(name)) {
      if (name === 'error') continue
      throw new TypeError(`Unknown FUSE operation ${String(name)}`)
    }
  }
}

function timeoutNumber (name, value) {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function mountString (name, value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
  if (/[\0,\\\r\n]/.test(value)) {
    throw new TypeError(`${name} cannot contain NUL, comma, backslash, or a newline`)
  }
  return value
}

function mountNumber (name, value) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`)
  return value
}

function mountInteger (name, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
  return value
}

function boundedInteger (name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`)
  if (value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function normalizeResult (result, operation) {
  if (result === null || result === undefined) return 0
  if (!Number.isInteger(result) || result < MIN_INT32 || result > MAX_INT32) return Fuse.EIO
  if (result > 0 && operation !== 'read' && operation !== 'write' &&
      operation !== 'writeBuffer' && operation !== 'copyFileRange' &&
      operation !== 'getxattr' && operation !== 'listxattr') {
    return Fuse.EIO
  }
  return result
}

function normalizeIOResult (result, length) {
  result = normalizeResult(result, 'read')
  if (result > length) throw new RangeError(`I/O callback returned ${result} bytes for a ${length}-byte buffer`)
  return result
}

function normalizeFileHandle (value) {
  if (value === null || value === undefined) return 0
  return toUint64Value(value, 'file handle')
}

/* Minimal errno -> name map for the backing-file errors we can hit. */
const BACKING_ERRNO_NAMES = new Map([
  [1, 'EPERM'],
  [9, 'EBADF'],
  [16, 'EBUSY'],
  [22, 'EINVAL'],
  [40, 'ELOOP'],
  [95, 'ENOTSUP'],
  [107, 'ENOTCONN']
])

function errnoName (code) {
  return BACKING_ERRNO_NAMES.get(code) || `UNKNOWN(${code})`
}

function normalizeOpenResult (result) {
  if (result === null || result === undefined ||
      typeof result === 'number' || typeof result === 'bigint') {
    return [normalizeFileHandle(result), 0]
  }
  if (typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('open result must be a file handle or file-info object')
  }

  for (const name of Reflect.ownKeys(result)) {
    if (typeof name !== 'string' || !FILE_INFO_RESULT_FIELDS.has(name)) {
      throw new TypeError(`Unknown file-info property ${String(name)}`)
    }
  }
  const fd = result.fd
  const directIO = result.directIO
  const keepCache = result.keepCache
  const nonseekable = result.nonseekable
  const backingId = result.backingId
  for (const [name, value] of [
    ['directIO', directIO],
    ['keepCache', keepCache],
    ['nonseekable', nonseekable]
  ]) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new TypeError(`file-info.${name} must be a boolean`)
    }
  }

  if (backingId !== undefined &&
      (!Number.isInteger(backingId) || backingId < 0)) {
    throw new TypeError('file-info.backingId must be a non-negative integer')
  }
  // The kernel rejects FOPEN_PASSTHROUGH combined with either of these
  // (fs/fuse/iomode.c), and the failure surfaces as an opaque EIO from
  // open(), so it is caught here instead.
  if (backingId > 0 && (keepCache || directIO)) {
    throw new TypeError('file-info.backingId cannot be combined with keepCache or directIO')
  }

  let flags = 0
  if (directIO) flags |= FILE_INFO_DIRECT_IO
  if (keepCache) flags |= FILE_INFO_KEEP_CACHE
  if (nonseekable) flags |= FILE_INFO_NONSEEKABLE
  return [normalizeFileHandle(fd), flags, backingId === undefined ? 0 : backingId]
}

function getReaddirOffsetsArray (offsets, length) {
  if (!Array.isArray(offsets) || offsets.length !== length) {
    throw new RangeError('readdirPaged offsets must align exactly with names')
  }
  const encoded = new Uint32Array(length * 2)
  for (let i = 0; i < offsets.length; i++) {
    const offset = toInt64(offsets[i], `readdirPaged.offsets[${i}]`)
    if (offset === 0n) throw new RangeError('readdirPaged offsets must be non-zero')
    setInt64(encoded, i * 2, offset, `readdirPaged.offsets[${i}]`)
  }
  return encoded
}

function encodeLock (lock) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    throw new TypeError('lock result must be an object')
  }
  const fields = new Set(['type', 'whence', 'start', 'length', 'pid'])
  for (const name of Reflect.ownKeys(lock)) {
    if (typeof name !== 'string' || !fields.has(name)) {
      throw new TypeError(`Unknown lock property ${String(name)}`)
    }
  }
  const encoded = new Uint32Array(8)
  encoded[0] = boundedInteger('lock.type', lock.type, 0, 0xffff)
  encoded[1] = boundedInteger('lock.whence', lock.whence, 0, 0xffff)
  setInt64(encoded, 2, lock.start, 'lock.start')
  setInt64(encoded, 4, lock.length, 'lock.length')
  const pid = lock.pid ?? 0
  if (!Number.isInteger(pid) || pid < MIN_INT32 || pid > MAX_INT32) {
    throw new RangeError('lock.pid must be a signed 32-bit integer')
  }
  encoded[6] = pid >>> 0
  return encoded
}

function encodeInt64 (value, name) {
  const encoded = new Uint32Array(2)
  setInt64(encoded, 0, value, name)
  return encoded
}

function getInitConfigArray (connection, requested) {
  if (requested === null || requested === undefined) return EMPTY_INIT_CONFIG
  if (typeof requested !== 'object' || Array.isArray(requested)) {
    throw new TypeError('init configuration must be an object')
  }

  const config = new Uint32Array(8)
  for (const name of Reflect.ownKeys(requested)) {
    if (typeof name !== 'string') throw new TypeError(`Unknown init configuration property ${String(name)}`)
    const field = INIT_CONFIG_FIELDS.get(name)
    if (!field) throw new TypeError(`Unknown init configuration property ${JSON.stringify(name)}`)
    const value = field.boolean
      ? booleanToUint32(requested[name], `init configuration.${name}`)
      : toUint32(requested[name], `init configuration.${name}`)
    if (value < field.minimum) {
      throw new RangeError(`init configuration.${name} must be at least ${field.minimum}`)
    }
    config[0] |= field.mask
    config[field.index] = value
  }

  for (const name of ['maxWrite', 'maxReadahead', 'maxBackground', 'congestionThreshold']) {
    const field = INIT_CONFIG_FIELDS.get(name)
    if ((config[0] & field.mask) !== 0 && config[field.index] > connection[name]) {
      throw new RangeError(`init configuration.${name} cannot exceed the kernel value ${connection[name]}`)
    }
  }
  const wantField = INIT_CONFIG_FIELDS.get('want')
  if ((config[0] & wantField.mask) !== 0 &&
      ((config[wantField.index] & (~connection.capable >>> 0)) >>> 0) !== 0) {
    throw new RangeError('init configuration.want contains capabilities unsupported by the kernel')
  }

  const backgroundField = INIT_CONFIG_FIELDS.get('maxBackground')
  const congestionField = INIT_CONFIG_FIELDS.get('congestionThreshold')
  const hasBackground = (config[0] & backgroundField.mask) !== 0
  const hasCongestion = (config[0] & congestionField.mask) !== 0
  const maxBackground = hasBackground ? config[backgroundField.index] : connection.maxBackground
  const congestionThreshold = hasCongestion ? config[congestionField.index] : connection.congestionThreshold
  if ((hasBackground || hasCongestion) &&
      congestionThreshold > maxBackground) {
    throw new RangeError('init configuration.congestionThreshold cannot exceed maxBackground')
  }
  return config
}

function booleanToUint32 (value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
  return value ? 1 : 0
}

function toUint32 (value, name) {
  if (value === undefined || value === null) return 0
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`)
  }
  return value
}

function toUint64Value (value, name) {
  const num = toUint64(value, name)
  return num <= MAX_SAFE_BIGINT ? Number(num) : num
}

function toUint64 (value, name) {
  let num
  if (typeof value === 'bigint') {
    num = value
  } else if (Number.isSafeInteger(value)) {
    num = BigInt(value)
  } else {
    throw new TypeError(`${name} must be a safe integer or bigint`)
  }
  if (num < 0n || num > 0xffffffffffffffffn) throw new RangeError(`${name} is outside the uint64 range`)
  return num
}

function toInt64 (value, name) {
  let num
  if (typeof value === 'bigint') {
    num = value
  } else if (Number.isSafeInteger(value)) {
    num = BigInt(value)
  } else {
    throw new TypeError(`${name} must be a safe integer or bigint`)
  }
  if (num < -0x8000000000000000n || num > 0x7fffffffffffffffn) {
    throw new RangeError(`${name} is outside the int64 range`)
  }
  return num
}

function setNonNegativeInt64 (arr, idx, value, name) {
  const num = toInt64(value, name)
  if (num < 0n) throw new RangeError(`${name} must be non-negative`)
  setInt64(arr, idx, num, name)
}
