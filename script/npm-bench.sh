#!/usr/bin/env bash
# Benchmarks npm package installs on native disk vs the computerd FUSE mount.
#
# Runs each scenario on both a native target directory and the computerd
# FUSE mount, repeating REPS times with WARMUP untimed runs first.
# Emits periodic heartbeats while npm is quiet so the run is
# distinguishable from a hang. Writes a JSON summary when OUTPUT_JSON
# is set.
#
# Scenarios:
#   express         npm install express --prefer-offline
#   computer        npm install for the cloudflare/computer monorepo
#   synthetic       a synthetic package tree with many tiny files
#
# Knobs (environment variables):
#   MOUNT           FUSE mount point (default: /tmp/workspace)
#   BASE            native baseline directory (default: /tmp/baseline)
#   REPS            timed repetitions per scenario per target (default: 3)
#   WARMUP          warm-up runs not included in results (default: 1)
#   SCENARIOS       comma-separated list of scenario names (default: express)
#   OUTPUT_JSON     path to write the JSON results file (optional)
#   HEARTBEAT_SEC   heartbeat interval in seconds (default: 10)
#   COMPUTERD_FUSE_TRACE  set to "summary" to collect a FUSE op trace per run
#   NPM_CACHE_DIR   npm cache directory (default: /tmp/npm-cache)
set -euo pipefail

MOUNT="${MOUNT:-/tmp/workspace}"
BASE="${BASE:-/tmp/baseline}"
REPS="${REPS:-3}"
WARMUP="${WARMUP:-1}"
SCENARIOS="${SCENARIOS:-express}"
OUTPUT_JSON="${OUTPUT_JSON:-}"
HEARTBEAT_SEC="${HEARTBEAT_SEC:-10}"
COMPUTERD_FUSE_TRACE="${COMPUTERD_FUSE_TRACE:-}"
NPM_CACHE_DIR="${NPM_CACHE_DIR:-/tmp/npm-cache}"

# Warm the npm cache for express so the FUSE install is not I/O bound.
warm_npm_cache() {
  local scenario="$1"
  echo "[bench] warming npm cache for $scenario"
  local warmdir
  warmdir="$(mktemp -d)"
  case "$scenario" in
    express)
      npm install express \
        --prefix "$warmdir" \
        --cache "$NPM_CACHE_DIR" \
        --prefer-offline \
        --ignore-scripts \
        --no-audit \
        --no-fund \
        >/dev/null 2>&1 || true
      ;;
    computer)
      if [ -d /tmp/computer-repo ]; then
        npm install \
          --prefix /tmp/computer-repo \
          --cache "$NPM_CACHE_DIR" \
          --prefer-offline \
          --ignore-scripts \
          --no-audit \
          --no-fund \
          >/dev/null 2>&1 || true
      fi
      ;;
    synthetic)
      # Nothing to warm for the synthetic scenario.
      ;;
  esac
  rm -rf "$warmdir"
  echo "[bench] cache warm for $scenario complete"
}

# Emit heartbeats every HEARTBEAT_SEC seconds while a background job runs.
# Prints timestamped lines to stdout. Call stop_heartbeat to cancel.
HEARTBEAT_PID=""
start_heartbeat() {
  local label="$1"
  (
    local elapsed=0
    while true; do
      sleep "$HEARTBEAT_SEC"
      elapsed=$((elapsed + HEARTBEAT_SEC))
      echo "[bench] heartbeat: ${label} still running after ${elapsed}s"
    done
  ) &
  HEARTBEAT_PID=$!
}
stop_heartbeat() {
  if [ -n "$HEARTBEAT_PID" ]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
    HEARTBEAT_PID=""
  fi
}

# Run a single npm install and return timing + stats via echoed JSON fields.
run_install() {
  local scenario="$1"
  local target_dir="$2"
  local label="$3"
  local run_idx="$4"

  local work_dir="${target_dir}/run-${run_idx}"
  rm -rf "$work_dir"
  mkdir -p "$work_dir"

  local npm_log="${work_dir}/.npm-debug.log"
  local start_ts
  start_ts="$(date +%s%N)"

  start_heartbeat "${label}/${scenario} run ${run_idx}"

  local exit_code=0
  case "$scenario" in
    express)
      npm install express \
        --prefix "$work_dir" \
        --cache "$NPM_CACHE_DIR" \
        --prefer-offline \
        --ignore-scripts \
        --no-audit \
        --no-fund \
        --loglevel warn \
        >"$npm_log" 2>&1 || exit_code=$?
      ;;
    computer)
      if [ ! -d /tmp/computer-repo ]; then
        echo "[bench] computer-repo not found; clone it to /tmp/computer-repo to use this scenario"
        stop_heartbeat
        echo '{"error":"computer-repo not found"}'
        return
      fi
      cp -r /tmp/computer-repo "$work_dir/repo"
      npm install \
        --prefix "$work_dir/repo" \
        --cache "$NPM_CACHE_DIR" \
        --prefer-offline \
        --ignore-scripts \
        --no-audit \
        --no-fund \
        --loglevel warn \
        >"$npm_log" 2>&1 || exit_code=$?
      ;;
    synthetic)
      # Generate a small package with many tiny files.
      local pkgdir="${work_dir}/synthetic-pkg"
      mkdir -p "$pkgdir"
      printf '{"name":"synthetic-bench","version":"1.0.0"}\n' >"$pkgdir/package.json"
      mkdir -p "$pkgdir/lib"
      for i in $(seq 1 200); do
        echo "module.exports = $i;" >"$pkgdir/lib/mod${i}.js"
      done
      npm pack "$pkgdir" --pack-destination "$NPM_CACHE_DIR" >/dev/null 2>&1 || true
      npm install "$pkgdir" \
        --prefix "$work_dir" \
        --cache "$NPM_CACHE_DIR" \
        --prefer-offline \
        --ignore-scripts \
        --no-audit \
        --no-fund \
        --loglevel warn \
        >"$npm_log" 2>&1 || exit_code=$?
      ;;
  esac

  stop_heartbeat

  local end_ts
  end_ts="$(date +%s%N)"
  local elapsed_ms=$(( (end_ts - start_ts) / 1000000 ))

  # Count files and directories.
  local file_count dir_count apparent_size
  file_count="$(find "$work_dir" -type f | wc -l || echo 0)"
  dir_count="$(find "$work_dir" -type d | wc -l || echo 0)"
  apparent_size="$(du -sb "$work_dir" 2>/dev/null | awk '{print $1}' || echo 0)"

  echo "{\"scenario\":\"${scenario}\",\"target\":\"${label}\",\"run\":${run_idx},\"elapsedMs\":${elapsed_ms},\"exitCode\":${exit_code},\"files\":${file_count},\"dirs\":${dir_count},\"apparentBytes\":${apparent_size}}"

  # Keep the last npm log for inspection.
  if [ "$exit_code" -ne 0 ]; then
    echo "[bench] npm exited $exit_code for ${label}/${scenario} run ${run_idx}:"
    tail -20 "$npm_log" >&2
  fi
}

# Collect results as a JSON array.
results="["
first_result=1

IFS=',' read -ra scenario_list <<< "$SCENARIOS"

for scenario in "${scenario_list[@]}"; do
  echo "[bench] scenario: $scenario"
  warm_npm_cache "$scenario"

  for target_label in "native:${BASE}" "fuse:${MOUNT}"; do
    label="${target_label%%:*}"
    target_dir="${target_label#*:}"
    mkdir -p "$target_dir"

    # Warm-up runs.
    for w in $(seq 1 "$WARMUP"); do
      echo "[bench] warmup ${w}/${WARMUP} ${label}/${scenario}"
      run_install "$scenario" "$target_dir" "$label" "warmup-${w}" >/dev/null
    done

    # Timed runs.
    for r in $(seq 1 "$REPS"); do
      echo "[bench] rep ${r}/${REPS} ${label}/${scenario}"
      result="$(run_install "$scenario" "$target_dir" "$label" "$r")"
      echo "[bench] result: $result"
      if [ "$first_result" -eq 1 ]; then
        results="${results}${result}"
        first_result=0
      else
        results="${results},${result}"
      fi
    done
  done
done

results="${results}]"

if [ -n "$OUTPUT_JSON" ]; then
  echo "$results" >"$OUTPUT_JSON"
  echo "[bench] results written to $OUTPUT_JSON"
fi

echo "[bench] done"
echo "$results"
