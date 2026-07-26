#!/usr/bin/env bash

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

TIMESTAMP="$(date -u +%Y-%m-%d_%H-%M-%S)"
REPORT_DIR="$ROOT/reports/$TIMESTAMP"
LOG_DIR="$REPORT_DIR/docker-logs"
RESULTS_FILE="$REPORT_DIR/results.tsv"
FULL_LOG="$REPORT_DIR/full.log"
REPORT_FILE="$REPORT_DIR/report.md"

mkdir -p "$LOG_DIR"
: > "$RESULTS_FILE"
: > "$FULL_LOG"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
LAST_DETAIL=""
FINISHED=0

exec > >(tee -a "$FULL_LOG") 2>&1

record_result() {
  local result="$1"
  local name="$2"
  local seconds="$3"
  local detail="${4:-}"

  detail="${detail//$'\t'/ }"
  detail="${detail//$'\n'/ }"

  printf '%s\t%s\t%s\t%s\n' \
    "$result" "$name" "$seconds" "$detail" >> "$RESULTS_FILE"

  case "$result" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    SKIP) SKIP_COUNT=$((SKIP_COUNT + 1)) ;;
  esac
}

run_test() {
  local name="$1"
  shift

  local started
  local ended
  local seconds
  local rc

  started="$(date +%s)"
  LAST_DETAIL=""

  echo
  echo "============================================================"
  echo "TEST: $name"
  echo "============================================================"

  if "$@"; then
    ended="$(date +%s)"
    seconds=$((ended - started))
    record_result "PASS" "$name" "$seconds" "${LAST_DETAIL:-Passed}"
    echo "PASS: $name"
  else
    rc=$?
    ended="$(date +%s)"
    seconds=$((ended - started))
    record_result "FAIL" "$name" "$seconds" "${LAST_DETAIL:-Exit code $rc}"
    echo "FAIL: $name"
  fi
}

skip_test() {
  local name="$1"
  local reason="$2"

  echo
  echo "SKIP: $name — $reason"
  record_result "SKIP" "$name" "0" "$reason"
}

preflight() {
  local missing=0

  for command_name in git node npm docker curl python3; do
    if command -v "$command_name" >/dev/null 2>&1; then
      echo "Found: $command_name"
    else
      echo "Missing: $command_name"
      missing=1
    fi
  done

  docker compose version

  if [[ -f .env ]]; then
    echo ".env exists"
  else
    echo "WARNING: .env is missing. LLM testing may be skipped."
  fi

  if [[ "$missing" -ne 0 ]]; then
    LAST_DETAIL="One or more required commands are missing"
    return 1
  fi

  LAST_DETAIL="Required commands are available"
}

compose_config_test() {
  if docker compose config >/dev/null; then
    LAST_DETAIL="Docker Compose configuration is valid"
    return 0
  fi

  LAST_DETAIL="Docker Compose configuration is invalid"
  return 1
}

wait_for_http() {
  local url="$1"
  local timeout_seconds="$2"
  local elapsed=0

  while (( elapsed < timeout_seconds )); do
    if curl --max-time 5 -fsS "$url" >/dev/null 2>&1; then
      LAST_DETAIL="$url returned successfully"
      return 0
    fi

    sleep 2
    elapsed=$((elapsed + 2))
  done

  LAST_DETAIL="Timed out waiting for $url"
  return 1
}

test_http_status() {
  local name="$1"
  local expected="$2"
  local method="$3"
  local url="$4"
  local body="${5:-}"
  local output_file="$REPORT_DIR/${name}.json"
  local status

  if [[ "$method" == "POST" ]]; then
    status="$(
      curl -sS \
        --max-time 30 \
        -o "$output_file" \
        -w '%{http_code}' \
        -X POST \
        -H 'Content-Type: application/json' \
        -d "$body" \
        "$url" || true
    )"
  else
    status="$(
      curl -sS \
        --max-time 30 \
        -o "$output_file" \
        -w '%{http_code}' \
        "$url" || true
    )"
  fi

  echo "HTTP status: $status"
  cat "$output_file" 2>/dev/null || true
  echo

  LAST_DETAIL="Expected $expected, received $status"
  [[ "$status" == "$expected" ]]
}

submit_and_wait_for_crawl() {
  local label="$1"
  local url="$2"
  local render_mode="$3"
  local max_pages="$4"
  local max_depth="$5"
  local timeout_seconds="$6"

  local safe_label
  local create_file
  local status_file
  local payload
  local http_status
  local crawl_id
  local crawl_status=""
  local elapsed=0
  local counters

  safe_label="$(echo "$label" | tr '[:upper:] ' '[:lower:]_')"
  create_file="$REPORT_DIR/${safe_label}-create.json"
  status_file="$REPORT_DIR/${safe_label}-status.json"

  payload="$(
    python3 - "$url" "$render_mode" "$max_pages" "$max_depth" <<'PY'
import json
import sys

print(json.dumps({
    "url": sys.argv[1],
    "renderMode": sys.argv[2],
    "maxPages": int(sys.argv[3]),
    "maxDepth": int(sys.argv[4]),
}))
PY
  )"

  http_status="$(
    curl -sS \
      --max-time 30 \
      -o "$create_file" \
      -w '%{http_code}' \
      -X POST \
      -H 'Content-Type: application/json' \
      -d "$payload" \
      http://localhost:3000/api/crawls || true
  )"

  echo "Create HTTP status: $http_status"
  cat "$create_file"
  echo

  if [[ "$http_status" != "202" ]]; then
    LAST_DETAIL="Crawl creation returned HTTP $http_status"
    return 1
  fi

  crawl_id="$(
    python3 - "$create_file" <<'PY'
import json
import sys

try:
    payload = json.load(open(sys.argv[1], encoding="utf-8"))
    print(payload.get("data", {}).get("id", ""))
except Exception:
    print("")
PY
  )"

  if [[ -z "$crawl_id" ]]; then
    LAST_DETAIL="Crawl response did not contain data.id"
    return 1
  fi

  echo "Crawl ID: $crawl_id"

  while (( elapsed < timeout_seconds )); do
    if curl -sS \
      --max-time 20 \
      "http://localhost:3000/api/crawls/$crawl_id" \
      -o "$status_file"; then

      crawl_status="$(
        python3 - "$status_file" <<'PY'
import json
import sys

try:
    payload = json.load(open(sys.argv[1], encoding="utf-8"))
    print(payload.get("data", {}).get("status", ""))
except Exception:
    print("")
PY
      )"

      echo "Crawl $crawl_id status: $crawl_status"

      if [[ "$crawl_status" == "COMPLETED" || "$crawl_status" == "FAILED" ]]; then
        break
      fi
    fi

    sleep 3
    elapsed=$((elapsed + 3))
  done

  if [[ "$crawl_status" != "COMPLETED" && "$crawl_status" != "FAILED" ]]; then
    LAST_DETAIL="Crawl $crawl_id timed out after ${timeout_seconds}s"
    return 1
  fi

  counters="$(
    python3 - "$status_file" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
data = payload.get("data", {})

print(
    f"discovered={data.get('discoveredCount', 0)}, "
    f"completed={data.get('completedCount', 0)}, "
    f"skipped={data.get('skippedCount', 0)}, "
    f"failed={data.get('failedCount', 0)}"
)
PY
  )"

  LAST_DETAIL="id=$crawl_id, status=$crawl_status, $counters"

  [[ "$crawl_status" == "COMPLETED" ]]
}

database_counts() {
  local counts

  counts="$(
    docker compose exec -T postgres \
      psql -U postgres -d distributed_rag \
      -At -F',' \
      -c "
        SELECT
          (SELECT COUNT(*) FROM crawls),
          (SELECT COUNT(*) FROM documents),
          (SELECT COUNT(*) FROM chunks),
          (
            SELECT COUNT(*)
            FROM chunks
            WHERE embedding IS NOT NULL
          );
      "
  )" || {
    LAST_DETAIL="Could not query PostgreSQL"
    return 1
  }

  echo "crawls,documents,chunks,embedded_chunks" \
    > "$REPORT_DIR/database-counts.csv"
  echo "$counts" >> "$REPORT_DIR/database-counts.csv"

  IFS=',' read -r DB_CRAWLS DB_DOCUMENTS DB_CHUNKS DB_EMBEDDED <<< "$counts"

  echo "Crawls: $DB_CRAWLS"
  echo "Documents: $DB_DOCUMENTS"
  echo "Chunks: $DB_CHUNKS"
  echo "Embedded chunks: $DB_EMBEDDED"

  LAST_DETAIL="crawls=$DB_CRAWLS, documents=$DB_DOCUMENTS, chunks=$DB_CHUNKS, embedded=$DB_EMBEDDED"

  [[ "${DB_DOCUMENTS:-0}" -gt 0 && "${DB_CHUNKS:-0}" -gt 0 ]]
}

ensure_embeddings() {
  database_counts || return 1

  if [[ "${DB_CHUNKS:-0}" -eq 0 ]]; then
    LAST_DETAIL="No chunks exist"
    return 1
  fi

  if [[ "${DB_EMBEDDED:-0}" -lt "${DB_CHUNKS:-0}" ]]; then
    echo "Some chunks are missing embeddings. Running backfill..."

    docker compose run --rm worker \
      node packages/workers/dist/src/cli/embeddings-backfill.js \
      --batch-size 8 \
      --limit 1000 || {
        LAST_DETAIL="Embedding backfill failed"
        return 1
      }
  else
    echo "Embeddings already exist."
  fi

  database_counts || return 1

  LAST_DETAIL="embedded=$DB_EMBEDDED of chunks=$DB_CHUNKS"
  [[ "${DB_EMBEDDED:-0}" -gt 0 ]]
}

search_test() {
  local label="$1"
  local base_url="$2"
  local mode="$3"
  local query="$4"
  local output_file="$REPORT_DIR/${label}.json"

  curl --get \
    -fsS \
    --max-time 240 \
    "$base_url/api/search" \
    --data-urlencode "q=$query" \
    --data-urlencode "mode=$mode" \
    --data-urlencode "limit=5" \
    -o "$output_file" || {
      LAST_DETAIL="Search request failed"
      return 1
    }

  python3 -m json.tool "$output_file"

  local result
  result="$(
    python3 - "$output_file" "$mode" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
expected_mode = sys.argv[2]
data = payload.get("data", {})

mode = data.get("mode")
count = int(data.get("resultCount", 0))

print(f"{mode},{count}")
PY
  )"

  local returned_mode
  local result_count

  IFS=',' read -r returned_mode result_count <<< "$result"

  LAST_DETAIL="mode=$returned_mode, results=$result_count"

  [[ "$returned_mode" == "$mode" && "${result_count:-0}" -gt 0 ]]
}

qna_test() {
  local output_file="$REPORT_DIR/grounded-question.json"

  curl -fsS \
    --max-time 180 \
    -X POST \
    -H 'Content-Type: application/json' \
    -d '{
      "question":"What information is available about book prices?",
      "limit":10
    }' \
    http://localhost:4173/api/ask \
    -o "$output_file" || {
      LAST_DETAIL="Grounded Q&A request failed"
      return 1
    }

  python3 -m json.tool "$output_file"

  local result
  result="$(
    python3 - "$output_file" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
grounded = payload.get("grounded") is True
citations = payload.get("citations", [])
answer = payload.get("answer", "")

print(f"{str(grounded).lower()},{len(citations)},{len(answer)}")
PY
  )"

  local grounded
  local citations
  local answer_length

  IFS=',' read -r grounded citations answer_length <<< "$result"

  LAST_DETAIL="grounded=$grounded, citations=$citations, answerCharacters=$answer_length"

  [[ "$grounded" == "true" && "${citations:-0}" -gt 0 ]]
}

collect_artifacts() {
  docker compose ps > "$REPORT_DIR/compose-status.txt" 2>&1 || true
  docker stats --no-stream > "$REPORT_DIR/docker-stats.txt" 2>&1 || true

  docker compose logs --no-color api \
    > "$LOG_DIR/api.log" 2>&1 || true

  docker compose logs --no-color worker \
    > "$LOG_DIR/worker.log" 2>&1 || true

  docker compose logs --no-color web \
    > "$LOG_DIR/web.log" 2>&1 || true

  docker compose logs --no-color postgres \
    > "$LOG_DIR/postgres.log" 2>&1 || true

  docker compose logs --no-color redis \
    > "$LOG_DIR/redis.log" 2>&1 || true
}

write_report() {
  local commit
  local result
  local name
  local seconds
  local detail

  commit="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

  {
    echo "# Distributed RAG Scraper Test Report"
    echo
    echo "- **UTC date:** $(date -u '+%Y-%m-%d %H:%M:%S')"
    echo "- **Git commit:** \`$commit\`"
    echo "- **Passed:** $PASS_COUNT"
    echo "- **Failed:** $FAIL_COUNT"
    echo "- **Skipped:** $SKIP_COUNT"
    echo "- **Report directory:** \`$REPORT_DIR\`"
    echo
    echo "## Test results"
    echo
    echo "| Result | Test | Seconds | Details |"
    echo "|---|---|---:|---|"

    while IFS=$'\t' read -r result name seconds detail; do
      name="${name//|/\\|}"
      detail="${detail//|/\\|}"
      echo "| $result | $name | $seconds | $detail |"
    done < "$RESULTS_FILE"

    echo
    echo "## Generated files"
    echo
    echo "- \`full.log\`"
    echo "- \`compose-status.txt\`"
    echo "- \`database-counts.csv\`"
    echo "- \`docker-stats.txt\`"
    echo "- \`docker-logs/api.log\`"
    echo "- \`docker-logs/worker.log\`"
    echo "- \`docker-logs/web.log\`"
    echo
    echo "## Manual checks still needed"
    echo
    echo "- Open the dashboard in a browser."
    echo "- Check desktop and mobile layout."
    echo "- Submit a crawl through the UI."
    echo "- Click citation links."
    echo "- Capture screenshots and record the final video."
  } > "$REPORT_FILE"
}

finish() {
  if [[ "$FINISHED" -eq 1 ]]; then
    return
  fi

  FINISHED=1

  echo
  echo "Collecting logs and writing report..."

  collect_artifacts
  write_report

  echo
  echo "============================================================"
  echo "TEST RUN COMPLETE"
  echo "============================================================"
  echo "Passed:  $PASS_COUNT"
  echo "Failed:  $FAIL_COUNT"
  echo "Skipped: $SKIP_COUNT"
  echo
  echo "Report:"
  echo "$REPORT_FILE"
  echo
  echo "Full log:"
  echo "$FULL_LOG"
}

trap finish EXIT

echo "Report directory: $REPORT_DIR"

run_test "Preflight commands" preflight
run_test "Install dependencies" npm ci
run_test "Generate Prisma client" npm run prisma:generate
run_test "Docker Compose configuration" compose_config_test
run_test "Lint" npm run lint
run_test "Build" npm run build
run_test "Unit and frontend tests" npm test

run_test "Build and start Docker stack" docker compose up -d --build
run_test "API health" wait_for_http http://localhost:3000/health 180
run_test "Frontend proxy health" wait_for_http http://localhost:4173/health 180
run_test "Frontend HTML" wait_for_http http://localhost:4173/ 180

run_test \
  "Reject invalid crawl URL" \
  test_http_status \
  invalid-crawl \
  422 \
  POST \
  http://localhost:3000/api/crawls \
  '{"url":"not-a-url"}'

run_test \
  "Reject invalid search mode" \
  test_http_status \
  invalid-search \
  422 \
  GET \
  'http://localhost:3000/api/search?q=book&mode=invalid'

run_test \
  "Reject empty question" \
  test_http_status \
  empty-question \
  422 \
  POST \
  http://localhost:3000/api/ask \
  '{"question":""}'

run_test \
  "Static crawl" \
  submit_and_wait_for_crawl \
  "Static books crawl" \
  "https://books.toscrape.com/" \
  "STATIC" \
  10 \
  2 \
  360

run_test \
  "JavaScript crawl" \
  submit_and_wait_for_crawl \
  "JavaScript quotes crawl" \
  "https://quotes.toscrape.com/js/" \
  "JAVASCRIPT" \
  3 \
  1 \
  360

run_test "Database documents and chunks" database_counts
run_test "Embedding backfill and verification" ensure_embeddings

run_test \
  "Keyword search through API" \
  search_test \
  keyword-api \
  http://localhost:3000 \
  keyword \
  "books"

run_test \
  "Semantic search through API" \
  search_test \
  semantic-api \
  http://localhost:3000 \
  semantic \
  "affordable books"

run_test \
  "Keyword search through frontend proxy" \
  search_test \
  keyword-frontend \
  http://localhost:4173 \
  keyword \
  "books"

if [[ "${RUN_LLM_TEST:-false}" == "true" ]]; then
  if docker compose exec -T api sh -lc \
    'test -n "$LLM_BASE_URL" && test -n "$LLM_API_KEY" && test -n "$LLM_MODEL"'
  then
    run_test "Live grounded Q&A" qna_test
  else
    skip_test "Live grounded Q&A" \
      "RUN_LLM_TEST=true, but the API container has incomplete LLM configuration"
  fi
else
  skip_test "Live grounded Q&A" \
    "Set RUN_LLM_TEST=true to enable the paid live-provider test"
fi

finish
trap - EXIT

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
