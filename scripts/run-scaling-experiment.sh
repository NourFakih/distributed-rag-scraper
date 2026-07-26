#!/usr/bin/env bash

set -Eeuo pipefail

readonly BENCHMARK_DATABASE="distributed_rag_scaling"
readonly BENCHMARK_REDIS_DATABASE="14"
readonly BENCHMARK_API_PORT="3100"
readonly BENCHMARK_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/${BENCHMARK_DATABASE}?schema=public"
readonly BENCHMARK_REDIS_URL="redis://localhost:6379/${BENCHMARK_REDIS_DATABASE}"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Usage: bash scripts/run-scaling-experiment.sh [--help]

Runs the same concurrent STATIC crawl workload twice:
  Round A: 1 independent worker process
  Round B: 3 independent worker processes

The benchmark uses only:
  PostgreSQL database: distributed_rag_scaling
  Redis logical DB:    14
  API port:             3100

The active distributed_rag database and Redis DB 0 are not modified.

Optional environment variables:
  SCALING_THIRD_URL          Add a third crawl origin.
  SCALING_THIRD_MAX_PAGES    Third crawl page cap (default: 30).
  SCALING_THIRD_MAX_DEPTH    Third crawl depth (default: 3).
  SCALING_TIMEOUT_SECONDS    Per-round timeout (default: 900).
  SCALING_API_TIMEOUT_SECONDS API startup timeout (default: 60).
  SCALING_POLL_SECONDS       Status polling interval (default: 2).
  SCALING_WORKER_CONCURRENCY BullMQ concurrency per worker (default: 5).

Prerequisites:
  - Existing Compose postgres and redis services are running and healthy.
  - npm run build has produced the API and worker dist files.
  - Ports 3100, 5432, and 6379 are available, unless the latter two are
    already published by this repository's Compose services.

This command performs public crawls and may take several minutes. It is not
executed by build, test, or validation commands.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "$#" -ne 0 ]]; then
  echo "Unknown argument: $1" >&2
  usage >&2
  exit 2
fi

readonly ROUND_TIMEOUT_SECONDS="${SCALING_TIMEOUT_SECONDS:-900}"
readonly API_TIMEOUT_SECONDS="${SCALING_API_TIMEOUT_SECONDS:-60}"
readonly POLL_SECONDS="${SCALING_POLL_SECONDS:-2}"
readonly WORKER_CONCURRENCY="${SCALING_WORKER_CONCURRENCY:-5}"
readonly REPORT_FILE="$ROOT/artifacts/scaling-results.md"

RUN_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/distributed-rag-scaling.XXXXXX")"
RESULTS_FILE="$RUN_DIRECTORY/results.tsv"
WORKLOAD_A_FILE="$RUN_DIRECTORY/round-a-workload.tsv"
WORKLOAD_B_FILE="$RUN_DIRECTORY/round-b-workload.tsv"

declare -a BENCHMARK_PIDS=()
declare -a BRIDGE_PIDS=()
declare -a WORKLOAD_NAMES=("Books to Scrape" "Quotes to Scrape")
declare -a WORKLOAD_URLS=(
  "https://books.toscrape.com/"
  "https://quotes.toscrape.com/"
)
declare -a WORKLOAD_MAX_PAGES=(40 30)
declare -a WORKLOAD_MAX_DEPTH=(3 3)

if [[ -n "${SCALING_THIRD_URL:-}" ]]; then
  WORKLOAD_NAMES+=("Optional third origin")
  WORKLOAD_URLS+=("$SCALING_THIRD_URL")
  WORKLOAD_MAX_PAGES+=("${SCALING_THIRD_MAX_PAGES:-30}")
  WORKLOAD_MAX_DEPTH+=("${SCALING_THIRD_MAX_DEPTH:-3}")
fi

mkdir -p "$ROOT/artifacts"
: > "$RESULTS_FILE"

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

require_positive_integer() {
  local name="$1"
  local value="$2"

  if ! is_positive_integer "$value"; then
    echo "$name must be a positive integer; received: $value" >&2
    exit 1
  fi
}

stop_benchmark_processes() {
  local pid
  local deadline

  if [[ "${#BENCHMARK_PIDS[@]}" -eq 0 ]]; then
    return
  fi

  for pid in "${BENCHMARK_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  deadline=$((SECONDS + 15))
  while (( SECONDS < deadline )); do
    local running=0
    for pid in "${BENCHMARK_PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        running=1
        break
      fi
    done
    if [[ "$running" -eq 0 ]]; then
      break
    fi
    sleep 1
  done

  for pid in "${BENCHMARK_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  done

  BENCHMARK_PIDS=()
}

cleanup() {
  local exit_code=$?
  local pid

  trap - EXIT INT TERM
  stop_benchmark_processes

  for pid in "${BRIDGE_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  done

  if [[ "$exit_code" -ne 0 ]]; then
    echo "Scaling experiment failed. Logs are preserved at: $RUN_DIRECTORY" >&2
  fi
  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

require_commands() {
  local command_name
  local missing=0

  for command_name in curl docker git node npx python3; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      echo "Missing required command: $command_name" >&2
      missing=1
    fi
  done

  if [[ "$missing" -ne 0 ]]; then
    exit 1
  fi

  docker compose version >/dev/null

  if [[ ! -f packages/api/dist/server.js ]]; then
    echo "Missing packages/api/dist/server.js; run npm run build first." >&2
    exit 1
  fi
  if [[ ! -f packages/workers/dist/index.js ]]; then
    echo "Missing packages/workers/dist/index.js; run npm run build first." >&2
    exit 1
  fi
}

validate_configuration() {
  local index

  require_positive_integer "SCALING_TIMEOUT_SECONDS" "$ROUND_TIMEOUT_SECONDS"
  require_positive_integer "SCALING_API_TIMEOUT_SECONDS" "$API_TIMEOUT_SECONDS"
  require_positive_integer "SCALING_POLL_SECONDS" "$POLL_SECONDS"
  require_positive_integer "SCALING_WORKER_CONCURRENCY" "$WORKER_CONCURRENCY"

  if [[ "$BENCHMARK_DATABASE" != "distributed_rag_scaling" ]]; then
    echo "Refusing to use unexpected benchmark database: $BENCHMARK_DATABASE" >&2
    exit 1
  fi
  if [[ "$BENCHMARK_DATABASE" == "distributed_rag" ]]; then
    echo "Refusing to use the active application database." >&2
    exit 1
  fi
  if [[ "$BENCHMARK_REDIS_DATABASE" != "14" || "$BENCHMARK_REDIS_DATABASE" == "0" ]]; then
    echo "Refusing to use unexpected Redis logical database: $BENCHMARK_REDIS_DATABASE" >&2
    exit 1
  fi

  for index in "${!WORKLOAD_URLS[@]}"; do
    require_positive_integer \
      "maxPages for ${WORKLOAD_NAMES[$index]}" \
      "${WORKLOAD_MAX_PAGES[$index]}"
    require_positive_integer \
      "maxDepth for ${WORKLOAD_NAMES[$index]}" \
      "${WORKLOAD_MAX_DEPTH[$index]}"

    if [[ "${WORKLOAD_URLS[$index]}" == *$'\n'* || "${WORKLOAD_URLS[$index]}" == *$'\t'* ]]; then
      echo "Workload URLs must not contain tabs or newlines." >&2
      exit 1
    fi
  done
}

compose_service_id() {
  local service="$1"
  local container_id
  local running

  container_id="$(docker compose ps -q "$service")"
  if [[ -z "$container_id" ]]; then
    echo "Compose service '$service' is not running." >&2
    exit 1
  fi

  running="$(docker inspect -f '{{.State.Running}}' "$container_id")"
  if [[ "$running" != "true" ]]; then
    echo "Compose service '$service' is not running." >&2
    exit 1
  fi

  printf '%s' "$container_id"
}

verify_compose_services() {
  compose_service_id postgres >/dev/null
  compose_service_id redis >/dev/null

  docker compose exec -T postgres \
    pg_isready -U postgres -d distributed_rag >/dev/null

  if [[ "$(docker compose exec -T redis redis-cli ping | tr -d '\r')" != "PONG" ]]; then
    echo "The Compose Redis service did not answer PING." >&2
    exit 1
  fi
}

tcp_port_open() {
  local port="$1"

  python3 - "$port" <<'PY'
import socket
import sys

try:
    with socket.create_connection(("localhost", int(sys.argv[1])), timeout=1):
        pass
except OSError:
    raise SystemExit(1)
PY
}

wait_for_tcp_port() {
  local port="$1"
  local deadline=$((SECONDS + 15))

  while (( SECONDS < deadline )); do
    if tcp_port_open "$port"; then
      return
    fi
    sleep 1
  done

  echo "Timed out waiting for localhost:$port." >&2
  exit 1
}

compose_publishes_exact_port() {
  local service="$1"
  local container_port="$2"
  local host_port="$3"
  local mapping

  mapping="$(docker compose port "$service" "$container_port" 2>/dev/null || true)"
  [[ "$mapping" == *":$host_port" ]]
}

container_ip() {
  local service="$1"
  local container_id
  local addresses

  container_id="$(compose_service_id "$service")"
  addresses="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' "$container_id")"
  addresses="${addresses%%$'\n'*}"

  if [[ -z "$addresses" ]]; then
    echo "Could not determine the '$service' container IP address." >&2
    exit 1
  fi

  printf '%s' "$addresses"
}

start_tcp_bridge() {
  local service="$1"
  local port="$2"
  local destination
  local log_file="$RUN_DIRECTORY/${service}-tcp-bridge.log"
  local pid

  if compose_publishes_exact_port "$service" "$port" "$port"; then
    wait_for_tcp_port "$port"
    echo "Using Compose-published localhost:$port for $service."
    return
  fi

  if tcp_port_open "$port"; then
    echo "localhost:$port is occupied but is not published by Compose service '$service'." >&2
    echo "Refusing to connect the benchmark to an unverified service." >&2
    exit 1
  fi

  destination="$(container_ip "$service")"
  node - "$port" "$destination" "$port" >"$log_file" 2>&1 <<'NODE' &
const net = require("node:net");

const listenPort = Number.parseInt(process.argv[2], 10);
const destinationHost = process.argv[3];
const destinationPort = Number.parseInt(process.argv[4], 10);

const server = net.createServer((incoming) => {
  const outgoing = net.createConnection({
    host: destinationHost,
    port: destinationPort,
  });

  incoming.on("error", () => outgoing.destroy());
  outgoing.on("error", () => incoming.destroy());
  incoming.pipe(outgoing);
  outgoing.pipe(incoming);
});

server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

server.listen(listenPort, "127.0.0.1");

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
NODE
  pid=$!
  BRIDGE_PIDS+=("$pid")
  wait_for_tcp_port "$port"

  if ! kill -0 "$pid" 2>/dev/null; then
    echo "The localhost bridge for $service exited unexpectedly." >&2
    exit 1
  fi
  echo "Started temporary localhost:$port bridge to Compose $service."
}

reset_benchmark_storage() {
  local redis_response
  local redis_size

  if [[ "$BENCHMARK_DATABASE" != "distributed_rag_scaling" || "$BENCHMARK_REDIS_DATABASE" != "14" ]]; then
    echo "Benchmark storage guard failed; refusing reset." >&2
    exit 1
  fi

  docker compose exec -T postgres \
    dropdb --if-exists --force -U postgres "$BENCHMARK_DATABASE"
  docker compose exec -T postgres \
    createdb -U postgres "$BENCHMARK_DATABASE"

  redis_response="$(
    docker compose exec -T redis \
      redis-cli -n "$BENCHMARK_REDIS_DATABASE" FLUSHDB | tr -d '\r'
  )"
  if [[ "$redis_response" != "OK" ]]; then
    echo "Redis DB $BENCHMARK_REDIS_DATABASE reset failed." >&2
    exit 1
  fi

  redis_size="$(
    docker compose exec -T redis \
      redis-cli -n "$BENCHMARK_REDIS_DATABASE" DBSIZE | tr -d '\r'
  )"
  if [[ "$redis_size" != "0" ]]; then
    echo "Redis DB $BENCHMARK_REDIS_DATABASE is not empty after reset." >&2
    exit 1
  fi
}

apply_migrations() {
  local round_directory="$1"

  DATABASE_URL="$BENCHMARK_DATABASE_URL" \
    npx prisma migrate deploy >"$round_directory/migrations.log" 2>&1

  docker compose exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U postgres -d "$BENCHMARK_DATABASE" \
      -Atc 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;' \
      >"$round_directory/applied-migration-count.txt"

  if [[ ! -s "$round_directory/applied-migration-count.txt" ]]; then
    echo "Could not verify migrations in $BENCHMARK_DATABASE." >&2
    exit 1
  fi
}

write_workload_file() {
  local output_file="$1"
  local index

  : > "$output_file"
  for index in "${!WORKLOAD_URLS[@]}"; do
    printf '%s\t%s\t%s\t%s\tSTATIC\n' \
      "${WORKLOAD_NAMES[$index]}" \
      "${WORKLOAD_URLS[$index]}" \
      "${WORKLOAD_MAX_PAGES[$index]}" \
      "${WORKLOAD_MAX_DEPTH[$index]}" \
      >> "$output_file"
  done
}

wait_for_api() {
  local api_pid="$1"
  local deadline=$((SECONDS + API_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    if curl --max-time 2 -fsS \
      "http://localhost:${BENCHMARK_API_PORT}/health" >/dev/null 2>&1; then
      return
    fi
    if ! kill -0 "$api_pid" 2>/dev/null; then
      echo "Benchmark API exited before becoming healthy." >&2
      return 1
    fi
    sleep 1
  done

  echo "Benchmark API did not become healthy within ${API_TIMEOUT_SECONDS}s." >&2
  return 1
}

wait_for_workers() {
  local round_directory="$1"
  local worker_count="$2"
  local deadline=$((SECONDS + 30))
  local ready
  local pid

  while (( SECONDS < deadline )); do
    ready=0
    for ((index = 1; index <= worker_count; index += 1)); do
      if grep -q 'Crawl worker is waiting for jobs' \
        "$round_directory/worker-${index}.log" 2>/dev/null; then
        ready=$((ready + 1))
      fi
    done
    if [[ "$ready" -eq "$worker_count" ]]; then
      return
    fi
    for pid in "${BENCHMARK_PIDS[@]:1}"; do
      if ! kill -0 "$pid" 2>/dev/null; then
        echo "A benchmark worker exited during startup." >&2
        return 1
      fi
    done
    sleep 1
  done

  echo "Workers did not become ready within 30 seconds." >&2
  return 1
}

start_benchmark_processes() {
  local round_directory="$1"
  local worker_count="$2"
  local api_pid
  local worker_pid
  local index

  NODE_ENV=production \
  PORT="$BENCHMARK_API_PORT" \
  DATABASE_URL="$BENCHMARK_DATABASE_URL" \
  REDIS_URL="$BENCHMARK_REDIS_URL" \
  LLM_BASE_URL= \
  LLM_API_KEY= \
  LLM_MODEL= \
    node packages/api/dist/server.js \
      >"$round_directory/api.log" 2>&1 &
  api_pid=$!
  BENCHMARK_PIDS+=("$api_pid")
  printf '%s\n' "$api_pid" > "$round_directory/api.pid"

  if ! wait_for_api "$api_pid"; then
    tail -n 40 "$round_directory/api.log" >&2 || true
    exit 1
  fi

  for ((index = 1; index <= worker_count; index += 1)); do
    NODE_ENV=production \
    DATABASE_URL="$BENCHMARK_DATABASE_URL" \
    REDIS_URL="$BENCHMARK_REDIS_URL" \
    env WORKER_CONCURRENCY="$WORKER_CONCURRENCY" \
      node packages/workers/dist/index.js \
        >"$round_directory/worker-${index}.log" 2>&1 &
    worker_pid=$!
    BENCHMARK_PIDS+=("$worker_pid")
    printf '%s\n' "$worker_pid" > "$round_directory/worker-${index}.pid"
  done

  if ! wait_for_workers "$round_directory" "$worker_count"; then
    for ((index = 1; index <= worker_count; index += 1)); do
      tail -n 40 "$round_directory/worker-${index}.log" >&2 || true
    done
    exit 1
  fi
}

create_payload() {
  local url="$1"
  local max_pages="$2"
  local max_depth="$3"

  python3 - "$url" "$max_pages" "$max_depth" <<'PY'
import json
import sys

print(json.dumps({
    "url": sys.argv[1],
    "maxPages": int(sys.argv[2]),
    "maxDepth": int(sys.argv[3]),
    "renderMode": "STATIC",
}))
PY
}

submit_workload() {
  local round_directory="$1"
  local index
  local payload
  local curl_pid
  local response_code
  local crawl_id
  local start_ms
  declare -a curl_pids=()
  declare -a crawl_ids=()

  for index in "${!WORKLOAD_URLS[@]}"; do
    create_payload \
      "${WORKLOAD_URLS[$index]}" \
      "${WORKLOAD_MAX_PAGES[$index]}" \
      "${WORKLOAD_MAX_DEPTH[$index]}" \
      > "$round_directory/payload-${index}.json"
  done

  start_ms="$(node -e 'process.stdout.write(String(Date.now()))')"

  for index in "${!WORKLOAD_URLS[@]}"; do
    payload="$(cat "$round_directory/payload-${index}.json")"
    curl --silent --show-error --max-time 30 \
      --output "$round_directory/create-${index}.json" \
      --write-out '%{http_code}' \
      --request POST \
      --header 'Content-Type: application/json' \
      --data "$payload" \
      "http://localhost:${BENCHMARK_API_PORT}/api/crawls" \
      > "$round_directory/create-${index}.status" &
    curl_pid=$!
    curl_pids+=("$curl_pid")
  done

  for index in "${!curl_pids[@]}"; do
    if ! wait "${curl_pids[$index]}"; then
      echo "Crawl submission $((index + 1)) failed." >&2
      exit 1
    fi
    response_code="$(cat "$round_directory/create-${index}.status")"
    if [[ "$response_code" != "202" ]]; then
      echo "Crawl submission $((index + 1)) returned HTTP $response_code." >&2
      cat "$round_directory/create-${index}.json" >&2 || true
      exit 1
    fi

    crawl_id="$(python3 - "$round_directory/create-${index}.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle).get("data", {}).get("id", ""))
PY
    )"
    if [[ -z "$crawl_id" ]]; then
      echo "Crawl submission $((index + 1)) did not return an ID." >&2
      exit 1
    fi
    crawl_ids+=("$crawl_id")
  done

  printf '%s\n' "$start_ms" > "$round_directory/start-ms.txt"
  printf '%s\n' "${crawl_ids[@]}" > "$round_directory/crawl-ids.txt"
}

assert_benchmark_processes_running() {
  local pid

  for pid in "${BENCHMARK_PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Benchmark process $pid exited before the workload completed." >&2
      exit 1
    fi
  done
}

wait_for_round() {
  local round_directory="$1"
  local round_name="$2"
  local worker_count="$3"
  local start_ms
  local end_ms
  local deadline=$((SECONDS + ROUND_TIMEOUT_SECONDS))
  local all_terminal
  local index
  local crawl_id
  local status
  local parsed
  local discovered=0
  local completed=0
  local skipped=0
  local failed=0
  local duration_seconds
  local pages_per_second
  local requested_pages=0
  local crawl_ids_csv=""
  local statuses_csv=""
  declare -a crawl_ids=()

  start_ms="$(cat "$round_directory/start-ms.txt")"
  mapfile -t crawl_ids < "$round_directory/crawl-ids.txt"

  while (( SECONDS < deadline )); do
    assert_benchmark_processes_running
    all_terminal=1

    for index in "${!crawl_ids[@]}"; do
      crawl_id="${crawl_ids[$index]}"
      if ! curl --silent --show-error --fail --max-time 15 \
        "http://localhost:${BENCHMARK_API_PORT}/api/crawls/${crawl_id}" \
        --output "$round_directory/final-${index}.json"; then
        all_terminal=0
        continue
      fi

      status="$(python3 - "$round_directory/final-${index}.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle).get("data", {}).get("status", ""))
PY
      )"
      if [[ "$status" != "COMPLETED" && "$status" != "FAILED" ]]; then
        all_terminal=0
      fi
    done

    if [[ "$all_terminal" -eq 1 ]]; then
      break
    fi
    sleep "$POLL_SECONDS"
  done

  if [[ "$all_terminal" -ne 1 ]]; then
    echo "Round $round_name exceeded the ${ROUND_TIMEOUT_SECONDS}s timeout." >&2
    exit 1
  fi

  end_ms="$(node -e 'process.stdout.write(String(Date.now()))')"

  for index in "${!crawl_ids[@]}"; do
    parsed="$(python3 - "$round_directory/final-${index}.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle).get("data", {})

counters = data.get("counters", {})
print("\t".join(str(value) for value in (
    data.get("status", ""),
    counters.get("discovered", 0),
    counters.get("completed", 0),
    counters.get("skipped", 0),
    counters.get("failed", 0),
)))
PY
    )"
    IFS=$'\t' read -r status crawl_discovered crawl_completed crawl_skipped crawl_failed <<< "$parsed"

    if [[ "$status" != "COMPLETED" ]]; then
      echo "Crawl ${crawl_ids[$index]} ended with unexpected status: $status" >&2
      exit 1
    fi

    discovered=$((discovered + crawl_discovered))
    completed=$((completed + crawl_completed))
    skipped=$((skipped + crawl_skipped))
    failed=$((failed + crawl_failed))
    requested_pages=$((requested_pages + WORKLOAD_MAX_PAGES[index]))

    if [[ -n "$crawl_ids_csv" ]]; then
      crawl_ids_csv+=", "
      statuses_csv+=", "
    fi
    crawl_ids_csv+="${crawl_ids[$index]}"
    statuses_csv+="$status"
  done

  if [[ "$completed" -le 0 ]]; then
    echo "Round $round_name completed no pages." >&2
    exit 1
  fi

  duration_seconds="$(python3 - "$start_ms" "$end_ms" <<'PY'
import sys

print(f"{(int(sys.argv[2]) - int(sys.argv[1])) / 1000:.3f}")
PY
  )"
  pages_per_second="$(python3 - "$completed" "$duration_seconds" <<'PY'
import sys

completed = int(sys.argv[1])
duration = float(sys.argv[2])
print(f"{completed / duration:.3f}" if duration > 0 else "0.000")
PY
  )"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$round_name" \
    "$worker_count" \
    "${#crawl_ids[@]}" \
    "$requested_pages" \
    "$discovered" \
    "$completed" \
    "$skipped" \
    "$failed" \
    "$duration_seconds" \
    "$pages_per_second" \
    "$crawl_ids_csv" \
    "$statuses_csv" \
    >> "$RESULTS_FILE"
}

run_round() {
  local round_slug="$1"
  local round_name="$2"
  local worker_count="$3"
  local workload_file="$4"
  local round_directory="$RUN_DIRECTORY/$round_slug"

  echo
  echo "Starting Round $round_name with $worker_count worker process(es)..."
  stop_benchmark_processes
  mkdir -p "$round_directory"
  write_workload_file "$workload_file"
  reset_benchmark_storage
  apply_migrations "$round_directory"
  start_benchmark_processes "$round_directory" "$worker_count"
  submit_workload "$round_directory"
  wait_for_round "$round_directory" "$round_name" "$worker_count"
  stop_benchmark_processes
}

print_results_and_write_report() {
  local round_a
  local round_b
  local speedup
  local improvement
  local conclusion
  local generated_at
  local index
  local round_name_a workers_a crawls_a requested_a discovered_a completed_a skipped_a failed_a duration_a throughput_a ids_a statuses_a
  local round_name_b workers_b crawls_b requested_b discovered_b completed_b skipped_b failed_b duration_b throughput_b ids_b statuses_b

  round_a="$(sed -n '1p' "$RESULTS_FILE")"
  round_b="$(sed -n '2p' "$RESULTS_FILE")"
  IFS=$'\t' read -r round_name_a workers_a crawls_a requested_a discovered_a completed_a skipped_a failed_a duration_a throughput_a ids_a statuses_a <<< "$round_a"
  IFS=$'\t' read -r round_name_b workers_b crawls_b requested_b discovered_b completed_b skipped_b failed_b duration_b throughput_b ids_b statuses_b <<< "$round_b"

  if [[ "$crawls_a" != "$crawls_b" || "$requested_a" != "$requested_b" ]] || ! cmp -s "$WORKLOAD_A_FILE" "$WORKLOAD_B_FILE"; then
    echo "The one-worker and three-worker workload definitions differ." >&2
    exit 1
  fi

  speedup="$(python3 - "$duration_a" "$duration_b" <<'PY'
import sys

one_worker = float(sys.argv[1])
three_workers = float(sys.argv[2])
print(f"{one_worker / three_workers:.3f}" if three_workers > 0 else "0.000")
PY
  )"
  improvement="$(python3 - "$throughput_a" "$throughput_b" <<'PY'
import sys

one_worker = float(sys.argv[1])
three_workers = float(sys.argv[2])
print(f"{((three_workers / one_worker) - 1) * 100:.1f}" if one_worker > 0 else "0.0")
PY
  )"
  conclusion="$(python3 - "$speedup" "$improvement" <<'PY'
import sys

speedup = float(sys.argv[1])
improvement = float(sys.argv[2])

if improvement > 5:
    print(
        f"Round B improved measured throughput by {improvement:.1f}% "
        f"with a {speedup:.3f}x duration speedup."
    )
elif improvement > 0:
    print(
        f"Round B produced only a small {improvement:.1f}% throughput "
        "improvement. Per-origin politeness, network latency, and crawl "
        "topology likely dominate the available worker capacity."
    )
else:
    print(
        f"Round B did not improve throughput ({improvement:.1f}%). "
        "Additional worker processes were not the bottleneck for this run; "
        "per-origin politeness, network latency, and crawl topology may "
        "dominate."
    )
PY
  )"

  echo
  printf '| Workers | Crawls | Completed pages | Failed | Duration seconds | Pages/second |\n'
  printf '|---------|--------|-----------------|--------|------------------|--------------|\n'
  printf '| %s | %s | %s | %s | %s | %s |\n' "$workers_a" "$crawls_a" "$completed_a" "$failed_a" "$duration_a" "$throughput_a"
  printf '| %s | %s | %s | %s | %s | %s |\n' "$workers_b" "$crawls_b" "$completed_b" "$failed_b" "$duration_b" "$throughput_b"
  echo
  echo "Speedup: ${speedup}x"
  echo "Throughput improvement: ${improvement}%"

  generated_at="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  {
    echo '# Horizontal Scaling Experiment Results'
    echo
    echo "- **Generated:** $generated_at"
    echo "- **Temporary PostgreSQL database:** \`$BENCHMARK_DATABASE\`"
    echo "- **Temporary Redis database:** \`$BENCHMARK_REDIS_DATABASE\`"
    echo "- **Per-worker BullMQ concurrency:** $WORKER_CONCURRENCY"
    echo "- **Raw logs and PID files:** \`$RUN_DIRECTORY\`"
    echo
    echo '## Exact workload'
    echo
    echo '| Name | URL | maxPages | maxDepth | renderMode |'
    echo '|---|---|---:|---:|---|'
    for index in "${!WORKLOAD_URLS[@]}"; do
      printf '| %s | %s | %s | %s | STATIC |\n' \
        "${WORKLOAD_NAMES[$index]}" \
        "${WORKLOAD_URLS[$index]}" \
        "${WORKLOAD_MAX_PAGES[$index]}" \
        "${WORKLOAD_MAX_DEPTH[$index]}"
    done
    echo
    echo 'Both rounds submitted every crawl concurrently. The benchmark database was dropped, recreated, and migrated before each round, and only Redis DB 14 was flushed. This prevents incremental recrawling from giving Round B a warm-document advantage.'
    echo
    echo '## Comparison'
    echo
    echo '| Workers | Crawls | Completed pages | Failed | Duration seconds | Pages/second |'
    echo '|---------|--------|-----------------|--------|------------------|--------------|'
    printf '| %s | %s | %s | %s | %s | %s |\n' "$workers_a" "$crawls_a" "$completed_a" "$failed_a" "$duration_a" "$throughput_a"
    printf '| %s | %s | %s | %s | %s | %s |\n' "$workers_b" "$crawls_b" "$completed_b" "$failed_b" "$duration_b" "$throughput_b"
    echo
    echo "- **Speedup:** ${speedup}x (one-worker duration / three-worker duration)"
    echo "- **Throughput improvement:** ${improvement}%"
    echo
    echo '## Raw metrics'
    echo
    echo '| Round | Workers | Crawls | Requested cap | Discovered | Completed | Skipped | Failed | Duration (s) | Pages/s | Crawl IDs | Final statuses |'
    echo '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|'
    printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' "$round_name_a" "$workers_a" "$crawls_a" "$requested_a" "$discovered_a" "$completed_a" "$skipped_a" "$failed_a" "$duration_a" "$throughput_a" "$ids_a" "$statuses_a"
    printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' "$round_name_b" "$workers_b" "$crawls_b" "$requested_b" "$discovered_b" "$completed_b" "$skipped_b" "$failed_b" "$duration_b" "$throughput_b" "$ids_b" "$statuses_b"
    echo
    echo '## Interpretation'
    echo
    echo 'Each worker was an independent OS process running the same built worker entry point. All workers shared BullMQ through the isolated Redis logical database and persisted to the isolated PostgreSQL database.'
    echo
    echo 'HTTP request starts remain globally rate-limited per origin through Redis, and robots.txt is respected. Multiple origins allow useful parallel work, but politeness limits cap the speedup available for each individual origin. A small or negative speedup is therefore an honest result when origin latency, crawl topology, or per-origin delays dominate worker capacity.'
    echo
    echo '## Conclusion'
    echo
    echo "$conclusion"
  } > "$REPORT_FILE"

  echo "Markdown report: $REPORT_FILE"
  echo "Process logs: $RUN_DIRECTORY"
}

main() {
  echo "This experiment performs two bounded public STATIC crawl rounds."
  echo "Active database distributed_rag and Redis DB 0 will not be modified."
  echo "Benchmark logs: $RUN_DIRECTORY"

  require_commands
  validate_configuration
  verify_compose_services
  if tcp_port_open "$BENCHMARK_API_PORT"; then
    echo "localhost:$BENCHMARK_API_PORT is already occupied; refusing to stop or reuse an untracked process." >&2
    exit 1
  fi
  start_tcp_bridge postgres 5432
  start_tcp_bridge redis 6379

  run_round round-a A 1 "$WORKLOAD_A_FILE"
  run_round round-b B 3 "$WORKLOAD_B_FILE"
  print_results_and_write_report
}

main
