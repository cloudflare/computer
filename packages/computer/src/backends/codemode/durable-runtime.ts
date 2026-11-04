// The isolate half of replayable runs, as module source.
//
// A replay has to show the code its events in the order it saw them the
// first time: the same responses, the same timer firings between them,
// the same clock readings and the same random numbers. While a run is
// live, this module logs each event as the code sees it: a response by
// the ordinal the host gave it, a timer by the order it was set in. The
// log rides along with the next capability call or output frame, so the
// host saves it before anything that came of those events. Whatever the
// code did after the last thing it sent, nobody saw, so a replay is free
// to order it differently.
//
// On replay the host answers journaled calls at once, and this module
// holds each response back, and each timer, until the log says it's its
// turn. Once the log runs out, the run carries on live: responses nobody
// saw the first time are released, and pending timers wait out the rest
// of their delay.
//
// The clock is virtual. It starts when the run did, moves to the time
// each journaled response was committed and to a timer's due time when it
// fires, and doesn't move otherwise, like the Workers clock between I/O.
// Random numbers come from a ChaCha20 stream over the run's seed. `fetch`
// goes through the host, which journals it like any other call.
//
// Nothing here runs unless the runner installs it for a replayable run.

export const DURABLE_MODULE = "workspace-durable.js";

export function durableRuntimeModule(): string {
  return `
    let active = false;
    let host;
    let virtualNow = 0;
    let startedAt = 0;
    // The order the run saw its events in before it was interrupted, and
    // how far the replay has followed it.
    let schedule = [];
    let cursor = 0;
    // Ordinals of the responses the rest of the schedule still places.
    const expected = new Set();
    // Events since the log was last sent, and the position of the first.
    let pending = [];
    let logged = 0;
    // A run that sets many timers between calls and output sends its log
    // on its own once this many events are waiting.
    const LOG_FLUSH = 4096;
    const received = new Map();
    // Responses the schedule doesn't place, released once it's done.
    const held = [];
    let inFlight = 0;
    const timers = new Map();
    let nextTimerId = 1;
    // Node's global timers hand back Timeout objects rather than numbers.
    // When the real ones do, these do too, mapped back to their timer.
    let nodeHandles = false;
    const handleIds = new WeakMap();
    let realSetTimeout;
    let realClearTimeout;
    let pumpScheduled = false;
    let stallCheck;
    let stalledSince;
    let stallReported = false;
    // How long the replay may wait for an event it saw before, with
    // nothing else left to do, before it counts as a different path.
    const STALL_MS = 1000;

    const replaying = () => cursor < schedule.length;
    const advance = (time) => {
      if (typeof time === "number" && time > virtualNow) virtualNow = time;
    };

    export function install(durable, bridge, call) {
      active = true;
      host = bridge;
      startedAt = durable.startedAt;
      virtualNow = startedAt;
      schedule = durable.schedule || [];
      logged = schedule.length;
      for (const event of schedule) if (event > 0) expected.add(event);
      realSetTimeout = globalThis.setTimeout;
      realClearTimeout = globalThis.clearTimeout;
      installRandom(durable.seed);
      installClock();
      installTimers();
      installFetch(call);
      if (replaying()) schedulePump();
    }

    function logEvent(event) {
      pending.push(event);
      if (pending.length >= LOG_FLUSH) {
        Promise.resolve(host.recordLog(takeLog())).catch(() => {});
      }
    }

    // The events logged since the last call, for the host to save.
    export function takeLog() {
      if (!active || pending.length === 0) return undefined;
      const chunk = { from: logged, events: pending };
      logged += pending.length;
      pending = [];
      return chunk;
    }

    // Called as a capability call leaves for the host.
    export function request() {
      if (active) inFlight += 1;
    }

    // Called when a capability call failed without a response.
    export function failed() {
      if (active) inFlight -= 1;
    }

    // Resolves with the response once the code may see it.
    export function deliver(payload) {
      if (!active) return payload;
      inFlight -= 1;
      return new Promise((resolve) => {
        const ordinal = payload.ordinal;
        const release = (replayed) => {
          advance(payload.at);
          if (!replayed && typeof ordinal === "number") logEvent(ordinal);
          resolve(payload);
        };
        // Not journaled, such as a limit the bridge refused, so it goes
        // straight back as it did the first time.
        if (typeof ordinal !== "number" || !replaying()) return release(false);
        if (expected.has(ordinal)) {
          received.set(ordinal, release);
          schedulePump();
        } else {
          held.push({ ordinal, release });
        }
      });
    }

    // One event per turn, so the code reacts to each before the next.
    function schedulePump() {
      if (pumpScheduled) return;
      pumpScheduled = true;
      realSetTimeout(pump, 0);
    }

    function pump() {
      pumpScheduled = false;
      if (!replaying()) return;
      const event = schedule[cursor];
      if (event > 0 ? received.has(event) : timers.has(-event)) {
        stalledSince = undefined;
        cursor += 1;
        if (event > 0) {
          const release = received.get(event);
          received.delete(event);
          expected.delete(event);
          release(true);
        } else {
          fire(-event, true);
        }
        if (replaying()) schedulePump();
        else finishReplay();
        return;
      }
      if (inFlight > 0) {
        // The code asked for something; wait for it to come back.
        stalledSince = undefined;
        return;
      }
      // The code isn't waiting on the host, and the next event hasn't
      // come. Async work the host doesn't see, such as hashing, can still
      // be running, so wait a little first.
      const now = realNow();
      stalledSince ??= now;
      if (now - stalledSince < STALL_MS) {
        // Check again soon. Anything that arrives first pumps at once.
        stallCheck ??= realSetTimeout(() => {
          stallCheck = undefined;
          schedulePump();
        }, 50);
        return;
      }
      if (!stallReported) {
        stallReported = true;
        Promise.resolve(host.reportStall()).catch(() => {});
      }
    }

    // The log has run out, so the run goes live.
    function finishReplay() {
      held.sort((a, b) => a.ordinal - b.ordinal);
      for (const { release } of held.splice(0)) release(false);
      for (const [id, timer] of timers) {
        if (timer.handle === undefined) {
          timer.handle = realSetTimeout(() => fire(id, false), Math.max(0, timer.due - virtualNow));
        }
      }
    }

    function arm(id, timer) {
      timer.handle = undefined;
      timers.set(id, timer);
      // While replaying, a timer fires when the log says it did.
      if (replaying()) return schedulePump();
      timer.handle = realSetTimeout(() => fire(id, false), Math.max(0, timer.due - virtualNow));
    }

    function addTimer(callback, delay, args, repeat) {
      const id = nextTimerId++;
      const step = Math.max(0, Number(delay) || 0);
      arm(id, { callback, args, repeat, step, due: virtualNow + step });
      if (!nodeHandles) return id;
      const handle = {
        ref() { return this; },
        unref() { return this; },
        hasRef() { return true; },
        refresh() {
          const timer = timers.get(id);
          if (timer !== undefined) {
            if (timer.handle !== undefined) realClearTimeout(timer.handle);
            arm(id, { ...timer, due: virtualNow + timer.step });
          }
          return this;
        },
        close() {
          cancelTimer(id);
          return this;
        },
        [Symbol.toPrimitive]: () => id,
      };
      handleIds.set(handle, id);
      return handle;
    }

    function fire(id, replayed) {
      const timer = timers.get(id);
      if (timer === undefined) return;
      timers.delete(id);
      advance(timer.due);
      if (!replayed) logEvent(-id);
      if (timer.repeat) arm(id, { ...timer, due: timer.due + Math.max(timer.step, 1) });
      if (typeof timer.callback !== "function") return;
      try {
        timer.callback(...timer.args);
      } catch (error) {
        // Report it as a throwing timer would, without stopping the pump.
        realSetTimeout(() => {
          throw error;
        }, 0);
      }
    }

    function cancelTimer(handle) {
      const id = typeof handle === "object" && handle !== null ? handleIds.get(handle) : handle;
      const timer = timers.get(id);
      if (timer === undefined) {
        if (handle !== undefined) realClearTimeout(handle);
        return;
      }
      timers.delete(id);
      if (timer.handle !== undefined) realClearTimeout(timer.handle);
    }

    function installTimers() {
      const probe = realSetTimeout(() => {}, 0);
      realClearTimeout(probe);
      nodeHandles = typeof probe === "object";
      globalThis.setTimeout = (callback, delay, ...args) => addTimer(callback, delay, args, false);
      globalThis.setInterval = (callback, delay, ...args) => addTimer(callback, delay, args, true);
      globalThis.clearTimeout = cancelTimer;
      globalThis.clearInterval = cancelTimer;
      if (typeof globalThis.setImmediate === "function") {
        globalThis.setImmediate = (callback, ...args) => addTimer(callback, 0, args, false);
        globalThis.clearImmediate = cancelTimer;
      }
      if (globalThis.scheduler && typeof globalThis.scheduler.wait === "function") {
        globalThis.scheduler.wait = (delay, options) =>
          new Promise((resolve, reject) => {
            const signal = options && options.signal;
            if (!signal) return void addTimer(resolve, delay, [], false);
            if (signal.aborted) return reject(signal.reason);
            const abort = () => {
              cancelTimer(timer);
              reject(signal.reason);
            };
            const timer = addTimer(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            }, delay, [], false);
            signal.addEventListener("abort", abort, { once: true });
          });
      }
      Object.defineProperty(AbortSignal, "timeout", {
        configurable: true,
        writable: true,
        value(delay) {
          const controller = new AbortController();
          addTimer(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), delay, [], false);
          return controller.signal;
        },
      });
    }

    // The real clock, for the stall grace period only.
    let RealDate = Date;
    const realNow = () => RealDate.now();

    function installClock() {
      RealDate = Date;
      function DurableDate(...args) {
        if (!new.target) return new RealDate(virtualNow).toString();
        return Reflect.construct(RealDate, args.length === 0 ? [virtualNow] : args, new.target);
      }
      DurableDate.prototype = RealDate.prototype;
      DurableDate.now = () => virtualNow;
      DurableDate.parse = RealDate.parse;
      DurableDate.UTC = RealDate.UTC;
      globalThis.Date = DurableDate;
      if (globalThis.performance) {
        Object.defineProperty(globalThis.performance, "now", {
          configurable: true,
          writable: true,
          value: () => virtualNow - startedAt,
        });
      }
    }

    function installRandom(seed) {
      const stream = chacha20(seed);
      Math.random = () => {
        const b = stream(7);
        return ((b[0] & 0x1f) * 2 ** 48 + b[1] * 2 ** 40 + b[2] * 2 ** 32 +
          b[3] * 2 ** 24 + b[4] * 2 ** 16 + b[5] * 2 ** 8 + b[6]) / 2 ** 53;
      };
      Object.defineProperty(crypto, "getRandomValues", {
        configurable: true,
        writable: true,
        value(array) {
          if (!ArrayBuffer.isView(array) || array instanceof Float32Array ||
              array instanceof Float64Array || array instanceof DataView) {
            throw new TypeError("getRandomValues takes an integer typed array.");
          }
          if (array.byteLength > 65536) {
            throw new DOMException("getRandomValues takes at most 65536 bytes.", "QuotaExceededError");
          }
          new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(stream(array.byteLength));
          return array;
        },
      });
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        writable: true,
        value() {
          const b = stream(16);
          b[6] = (b[6] & 0x0f) | 0x40;
          b[8] = (b[8] & 0x3f) | 0x80;
          const hex = [...b].map((byte) => byte.toString(16).padStart(2, "0")).join("");
          return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" +
            hex.slice(16, 20) + "-" + hex.slice(20);
        },
      });
    }

    // ChaCha20 keystream over a 256-bit key: returns n bytes at a time.
    function chacha20(seed) {
      const state = new Uint32Array(16);
      state.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
      for (let i = 0; i < 8; i++) state[4 + i] = parseInt(seed.slice(i * 8, i * 8 + 8), 16);
      const block = new Uint32Array(16);
      const bytes = new Uint8Array(block.buffer);
      const x = new Uint32Array(16);
      let offset = 64;
      const rotl = (v, n) => (v << n) | (v >>> (32 - n));
      const quarter = (a, b, c, d) => {
        x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 16);
        x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 12);
        x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 8);
        x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 7);
      };
      const refill = () => {
        x.set(state);
        for (let round = 0; round < 10; round++) {
          quarter(0, 4, 8, 12); quarter(1, 5, 9, 13); quarter(2, 6, 10, 14); quarter(3, 7, 11, 15);
          quarter(0, 5, 10, 15); quarter(1, 6, 11, 12); quarter(2, 7, 8, 13); quarter(3, 4, 9, 14);
        }
        for (let i = 0; i < 16; i++) block[i] = x[i] + state[i];
        state[12] += 1;
        if (state[12] === 0) state[13] += 1;
        offset = 0;
      };
      return (n) => {
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          if (offset === 64) refill();
          out[i] = bytes[offset++];
        }
        return out;
      };
    }

    // fetch goes through the host as a capability call, so it's journaled
    // and its response replays like any other.
    function installFetch(call) {
      const nullBody = new Set([101, 103, 204, 205, 304]);
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const signal = init && init.signal ? init.signal : input instanceof Request ? input.signal : undefined;
        if (signal && signal.aborted) throw signal.reason;
        const body = request.method === "GET" || request.method === "HEAD"
          ? null
          : new Uint8Array(await request.arrayBuffer());
        const pending = call("net", "fetch", [{
          url: request.url,
          method: request.method,
          redirect: request.redirect,
          headers: [...request.headers],
          body,
        }]);
        let abort;
        const result = await (signal
          ? Promise.race([pending, new Promise((_, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
            })]).finally(() => signal.removeEventListener("abort", abort))
          : pending);
        const response = new Response(nullBody.has(result.status) ? null : result.body, {
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
        });
        Object.defineProperty(response, "url", { value: result.url });
        Object.defineProperty(response, "redirected", { value: result.redirected });
        return response;
      };
    }
  `;
}
