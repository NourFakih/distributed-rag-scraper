#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

LOG_FILE="$ROOT/.codespace-startup.log"
exec >>"$LOG_FILE" 2>&1

echo
echo "============================================================"
echo "Codespace startup: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "============================================================"

echo "Waiting for Docker..."
for attempt in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    echo "Docker is ready."
    break
  fi

  if [[ "$attempt" -eq 60 ]]; then
    echo "Docker did not become ready."
    exit 1
  fi

  sleep 2
done

if [[ ! -f .env ]]; then
  echo "Creating .env from .env.example"
  cp .env.example .env
fi

echo "Validating Docker Compose..."
docker compose config >/dev/null

echo "Starting application containers..."
docker compose up -d

echo "Waiting for API..."
for attempt in $(seq 1 90); do
  if curl --max-time 5 -fsS http://localhost:3000/health >/dev/null 2>&1; then
    echo "API is ready."
    break
  fi

  if [[ "$attempt" -eq 90 ]]; then
    echo "API did not become healthy."
    docker compose logs --tail=100 api
    exit 1
  fi

  sleep 2
done

echo "Waiting for frontend..."
for attempt in $(seq 1 60); do
  if curl --max-time 5 -fsS http://localhost:4173/ >/dev/null 2>&1; then
    echo "Frontend is ready."
    break
  fi

  if [[ "$attempt" -eq 60 ]]; then
    echo "Frontend did not become healthy."
    docker compose logs --tail=100 web
    exit 1
  fi

  sleep 2
done

docker compose ps

echo
echo "Application ready:"
echo "Frontend: http://localhost:4173"
echo "API:      http://localhost:3000"

if [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; then
  echo "Forwarded frontend:"
  echo "https://${CODESPACE_NAME}-4173.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/"
fi
