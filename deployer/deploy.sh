#!/usr/bin/env bash
# Self-deploy / restore pipeline for the runhelm orchestrator.
#
# Invoked by the orchestrator as a one-shot container. Two modes:
#   MODE=deploy   — git pull + build + recreate + health-gate + rollback-on-fail
#   MODE=restore  — restore a named backup (image + sqlite) and recreate
#
# Inputs (env):
#   RUN_ID              unique id for this run (used for output files)
#   MODE                "deploy" | "restore"
#   SHA                 short commit sha (deploy mode, informational)
#   ATTEMPT             attempt number 1..N (deploy mode)
#   BACKUP_ID           restore target id (restore mode) OR fresh backup id
#                       that orchestrator created right before spawning us
#   PREV_BACKUP_ID      last known-good backup id (used as the rollback target
#                       if the new deploy fails; in restore mode identical to
#                       BACKUP_ID)
#   STACK_DIR           default /stack   — bind mount of the compose stack
#   BACKUPS_DIR         default /backups — bind mount of ./data/backups
#   DB_DIR              default /db      — bind mount of ./data/db
#   SERVICE_NAME        default "orchestrator"
#   COMPOSE_FILE        default "${STACK_DIR}/docker-compose.yml"
#   COMPOSE_PROJECT     default (read from docker label of running orchestrator)
#   ORCHESTRATOR_IMAGE  default "runhelm:latest"
#   HEALTH_URL          default "http://orchestrator:8787/healthz"
#   HEALTH_TIMEOUT_S    default 120
#   DB_FILE_NAME        default "orchestrator.sqlite"
#
# Output:
#   /backups/failures/<RUN_ID>.json   on failure (picked up by orchestrator on boot)
#   stdout/stderr                     captured by docker logs; last 200 lines
#                                     go into the failure json

set -u

log() { printf '[deploy %s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

: "${MODE:=deploy}"
: "${RUN_ID:=$(date -u +%Y%m%dT%H%M%SZ)-$$}"
: "${STACK_DIR:=/stack}"
: "${BACKUPS_DIR:=/backups}"
: "${DB_DIR:=/db}"
: "${SERVICE_NAME:=orchestrator}"
: "${COMPOSE_FILE:=${STACK_DIR}/docker-compose.yml}"
: "${ORCHESTRATOR_IMAGE:=runhelm:latest}"
: "${HEALTH_URL:=http://orchestrator:8787/healthz}"
: "${HEALTH_TIMEOUT_S:=120}"
: "${DB_FILE_NAME:=orchestrator.sqlite}"

FAILURES_DIR="${BACKUPS_DIR}/failures"
mkdir -p "$FAILURES_DIR"

IMAGE_REPO="${ORCHESTRATOR_IMAGE%%:*}"
PHASE="init"
LOG_FILE="$(mktemp)"

trap 'rm -f "$LOG_FILE"' EXIT

capture() {
  # run "$@" but tee output into LOG_FILE, preserving exit code
  "$@" > >(tee -a "$LOG_FILE") 2> >(tee -a "$LOG_FILE" >&2)
}

detect_project() {
  if [[ -n "${COMPOSE_PROJECT:-}" ]]; then
    echo "$COMPOSE_PROJECT"
    return 0
  fi
  local cid
  cid=$(docker ps --filter "label=com.docker.compose.service=${SERVICE_NAME}" \
                  --format '{{.ID}}' | head -n1)
  if [[ -n "$cid" ]]; then
    docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$cid"
  fi
}

compose() {
  local project
  project="$(detect_project)"
  if [[ -z "$project" ]]; then
    # fall back to directory-derived project name (compose's default)
    project="$(basename "$STACK_DIR")"
  fi
  docker compose -f "$COMPOSE_FILE" -p "$project" "$@"
}

write_failure_report() {
  local reason="$1"
  local tail
  tail=$(tail -n 200 "$LOG_FILE" 2>/dev/null | sed 's/\x1b\[[0-9;]*[A-Za-z]//g')
  local out="${FAILURES_DIR}/${RUN_ID}.json"
  jq -n \
    --arg run_id "$RUN_ID" \
    --arg mode "$MODE" \
    --arg sha "${SHA:-}" \
    --arg attempt "${ATTEMPT:-1}" \
    --arg phase "$PHASE" \
    --arg reason "$reason" \
    --arg prev_backup "${PREV_BACKUP_ID:-}" \
    --arg log "$tail" \
    '{
      run_id:       $run_id,
      mode:         $mode,
      sha:          $sha,
      attempt:     ($attempt | tonumber? // 1),
      phase:        $phase,
      reason:       $reason,
      prev_backup:  $prev_backup,
      log_tail:     $log,
      finished_at: (now * 1000 | floor)
     }' > "$out"
  log "wrote failure report: $out"
}

wait_healthy() {
  local url="$1"
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
  while (( $(date +%s) < deadline )); do
    if curl -fsS -o /dev/null --max-time 5 "$url"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

restore_image_and_db() {
  local backup_id="$1"
  [[ -z "$backup_id" ]] && { log "no backup id to restore from"; return 1; }

  local backup_tag="${IMAGE_REPO}:backup-${backup_id}"
  local db_backup="${BACKUPS_DIR}/db-${backup_id}.sqlite"

  log "restoring image ${backup_tag} → ${ORCHESTRATOR_IMAGE}"
  if ! docker tag "$backup_tag" "$ORCHESTRATOR_IMAGE" 2>&1 | tee -a "$LOG_FILE"; then
    log "failed to retag backup image"
    return 1
  fi

  if [[ -f "$db_backup" ]]; then
    log "restoring db from ${db_backup}"
    cp -f "$db_backup" "${DB_DIR}/${DB_FILE_NAME}" || {
      log "db restore failed"
      return 1
    }
  else
    log "no db backup file at ${db_backup} — leaving current db in place"
  fi

  PHASE="restore-up"
  capture compose up -d --force-recreate "$SERVICE_NAME" || return 1

  PHASE="restore-health"
  if ! wait_healthy "$HEALTH_URL"; then
    log "post-restore health-check failed"
    return 1
  fi
  return 0
}

run_deploy() {
  PHASE="pull"
  log "git pull in $STACK_DIR"
  capture git -C "$STACK_DIR" fetch --all --prune \
    || { write_failure_report "git fetch failed"; return 1; }
  capture git -C "$STACK_DIR" pull --ff-only \
    || { write_failure_report "git pull --ff-only failed"; return 1; }

  PHASE="build"
  log "compose build $SERVICE_NAME"
  capture compose build "$SERVICE_NAME" \
    || { write_failure_report "docker compose build failed"; return 1; }

  PHASE="up"
  log "compose up -d --force-recreate $SERVICE_NAME"
  capture compose up -d --force-recreate "$SERVICE_NAME" \
    || { write_failure_report "docker compose up failed"; return 1; }

  PHASE="health"
  log "waiting for $HEALTH_URL (timeout ${HEALTH_TIMEOUT_S}s)"
  if ! wait_healthy "$HEALTH_URL"; then
    write_failure_report "healthcheck timed out"
    return 1
  fi

  PHASE="done"
  log "deploy ok"
  return 0
}

run_restore() {
  PHASE="restore"
  if ! restore_image_and_db "${BACKUP_ID:-}"; then
    write_failure_report "restore failed"
    return 1
  fi
  PHASE="done"
  log "restore ok"
  return 0
}

case "$MODE" in
  deploy)
    if run_deploy; then
      exit 0
    fi
    log "deploy failed in phase '$PHASE' — attempting rollback to ${PREV_BACKUP_ID:-<none>}"
    if [[ -n "${PREV_BACKUP_ID:-}" ]]; then
      PHASE="rollback"
      if restore_image_and_db "$PREV_BACKUP_ID"; then
        log "rollback succeeded — orchestrator back on previous backup"
      else
        log "ROLLBACK FAILED — system may be down"
      fi
    fi
    exit 1
    ;;
  restore)
    run_restore
    exit $?
    ;;
  *)
    die "unknown MODE=$MODE"
    ;;
esac
