#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

image="${RAWROUTE_IMAGE:-rawroute:latest}"
live_name="${RAWROUTE_LIVE_CONTAINER:-rawroute}"
next_name="${RAWROUTE_NEXT_CONTAINER:-rawroute-next}"
preflight_name="${RAWROUTE_PREFLIGHT_CONTAINER:-rawroute-preflight}"
rawroute_network="${RAWROUTE_NETWORK:-rawroute}"
dokploy_network="${RAWROUTE_DOKPLOY_NETWORK:-dokploy-network}"
public_port="${RAWROUTE_PORT:-18080}"
preflight_port="${RAWROUTE_PREFLIGHT_PORT:-18081}"
health_path="${RAWROUTE_HEALTH_PATH:-/api/health}"
traefik_file="${RAWROUTE_TRAEFIK_FILE:-/etc/dokploy/traefik/dynamic/rawroute.yml}"
health_retries="${RAWROUTE_HEALTH_RETRIES:-30}"
drain_retries="${RAWROUTE_DRAIN_RETRIES:-60}"
timestamp="$(date -u +%Y%m%d%H%M%S)"

read -r -a public_domains <<< "${RAWROUTE_VERIFY_DOMAINS:-rawroute.halodev.dpdns.org ccs.halodev.dpdns.org api.ccs.halodev.dpdns.org dashboard.ccs.halodev.dpdns.org 9router.halodev.dpdns.org ccs.halotec.my.id api.ccs.halotec.my.id dashboard.ccs.halotec.my.id}"

deployment_env_file="$(mktemp /tmp/rawroute-deploy-env.XXXXXX)"
browser_dom_file="$(mktemp /tmp/rawroute-deploy-dom.XXXXXX)"
browser_error_file="$(mktemp /tmp/rawroute-deploy-browser.XXXXXX)"
traefik_backup="${traefik_file}.bak-before-rawroute-${timestamp}"

handoff_ip=""
handoff_active=false
traefik_changed=false
old_retirement_started=false
old_ip=""
route_localnet_all="$(cat /proc/sys/net/ipv4/conf/all/route_localnet)"
route_localnet_lo="$(cat /proc/sys/net/ipv4/conf/lo/route_localnet)"

log() {
  printf '[rawroute-deploy] %s\n' "$*"
}

die() {
  log "ERROR: $*"
  return 1
}

as_root() {
  if [[ "$(id -u)" == "0" ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

cleanup_handoff() {
  local target="$1"
  as_root iptables -t nat -D PREROUTING -p tcp --dport "$public_port" -m comment --comment rawroute_cookie_handoff -j DNAT --to-destination "${target}:8080" 2>/dev/null || true
  as_root iptables -t nat -D OUTPUT -p tcp -d 127.0.0.1 --dport "$public_port" -m comment --comment rawroute_cookie_handoff -j DNAT --to-destination "${target}:8080" 2>/dev/null || true
  as_root iptables -t nat -D POSTROUTING -p tcp -d "$target" --dport 8080 -m comment --comment rawroute_cookie_handoff -j MASQUERADE 2>/dev/null || true
}

restore_network_sysctls() {
  as_root sysctl -w "net.ipv4.conf.all.route_localnet=${route_localnet_all}" >/dev/null
  as_root sysctl -w "net.ipv4.conf.lo.route_localnet=${route_localnet_lo}" >/dev/null
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  set +e

  if [[ "$exit_code" != "0" ]]; then
    log "Deployment failed. Existing traffic state is being preserved."
    if [[ "$old_retirement_started" != true ]]; then
      if [[ "$traefik_changed" == true ]]; then
        as_root cp "$traefik_backup" "$traefik_file"
      fi
      if [[ "$handoff_active" == true && -n "$handoff_ip" ]]; then
        cleanup_handoff "$handoff_ip"
        restore_network_sysctls
      fi
      docker container rm --force "$next_name" >/dev/null 2>&1 || true
      docker container rm --force "$preflight_name" >/dev/null 2>&1 || true
    else
      log "The old container was already retired; leaving the replacement path running for zero-downtime recovery."
      log "Inspect containers: $next_name and $live_name"
    fi
  else
    if [[ "$handoff_active" == true && -n "$handoff_ip" ]]; then
      cleanup_handoff "$handoff_ip"
      restore_network_sysctls
    fi
    docker container rm --force "$preflight_name" >/dev/null 2>&1 || true
    docker container rm --force "$next_name" >/dev/null 2>&1 || true
  fi

  shred -u "$deployment_env_file" "$browser_dom_file" "$browser_error_file" 2>/dev/null || true
  exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

if [[ "$(id -u)" != "0" ]]; then
  sudo -v
fi

command -v docker >/dev/null || die "docker is required."
command -v curl >/dev/null || die "curl is required."
command -v jq >/dev/null || die "jq is required for Traefik verification."
command -v ss >/dev/null || die "ss is required for connection draining."

browser="$(command -v chromium-browser || command -v chromium || true)"
[[ -n "$browser" ]] || die "chromium-browser or chromium is required for browser verification."

docker inspect "$live_name" >/dev/null 2>&1 || die "Live container $live_name was not found."
docker inspect "$next_name" >/dev/null 2>&1 && die "Temporary container $next_name already exists; remove or inspect it before retrying."

log "Building $image"
docker build -t "$image" .

log "Copying the live environment to a protected temporary file"
docker inspect "$live_name" --format '{{range .Config.Env}}{{println .}}{{end}}' > "$deployment_env_file"
chmod 600 "$deployment_env_file"

grep -q '^DATABASE_URL=' "$deployment_env_file" || die "Live environment is missing DATABASE_URL."
grep -q '^SESSION_SECRET=' "$deployment_env_file" || die "Live environment is missing SESSION_SECRET."

log "Backing up Traefik configuration to $traefik_backup"
as_root cp "$traefik_file" "$traefik_backup"

wait_health() {
  local url="$1"
  local attempt
  for attempt in $(seq 1 "$health_retries"); do
    if curl --max-time 5 -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

log "Starting isolated preflight on :$preflight_port"
docker container rm --force "$preflight_name" >/dev/null 2>&1 || true
docker run -d \
  --name "$preflight_name" \
  --env-file "$deployment_env_file" \
  --network "$rawroute_network" \
  --network-alias "$preflight_name" \
  -p "$preflight_port:8080" \
  "$image" >/dev/null
docker network connect "$dokploy_network" "$preflight_name"

wait_health "http://127.0.0.1:${preflight_port}${health_path}" || die "Preflight health check failed."
"$browser" --headless --no-sandbox --disable-gpu --dump-dom "http://127.0.0.1:${preflight_port}/login" > "$browser_dom_file" 2> "$browser_error_file"
grep -q '<title>RawRoute' "$browser_dom_file" || die "Preflight browser verification did not render RawRoute."
grep -q 'Sign in' "$browser_dom_file" || die "Preflight browser verification did not render the login page."
docker logs --tail 40 "$preflight_name"
docker container rm --force "$preflight_name" >/dev/null

container_ip() {
  docker inspect "$1" --format "{{(index .NetworkSettings.Networks \"$rawroute_network\").IPAddress}}"
}

verify_container() {
  local name="$1"
  local ip
  ip="$(container_ip "$name")"
  [[ -n "$ip" ]] || die "Container $name is not attached to $rawroute_network."
  wait_health "http://${ip}:8080${health_path}" || die "Container $name failed its direct health check."
  log "$name is healthy at $ip:8080"
}

set_traefik_backend() {
  local target="$1"
  as_root sed -i -E "s#(url: http://)(rawroute|rawroute-next|rawroute-preflight):8080#\\1${target}:8080#g" "$traefik_file"
  traefik_changed=true
}

verify_traefik_backend() {
  local target="$1"
  local url="http://${target}:8080"
  curl -fsS http://127.0.0.1:8080/api/http/services | jq -e --arg url "$url" 'map(select(.name == "rawroute-service@file"))[0].serverStatus[$url] == "UP"' >/dev/null || die "Traefik does not report $url as UP."
}

verify_public_domains() {
  local domain
  for domain in "${public_domains[@]}"; do
    curl -kfsS --max-time 10 -o /dev/null "https://${domain}${health_path}" || die "Public health check failed for $domain."
    log "$domain is healthy"
  done
}

log "Starting the replacement beside the live container"
docker run -d \
  --name "$next_name" \
  --env-file "$deployment_env_file" \
  --network "$rawroute_network" \
  --network-alias "$next_name" \
  "$image" >/dev/null
docker network connect "$dokploy_network" "$next_name"
verify_container "$next_name"

log "Switching Traefik to $next_name"
set_traefik_backend "$next_name"
sleep 3
verify_traefik_backend "$next_name"
verify_public_domains

next_ip="$(container_ip "$next_name")"
old_ip="$(container_ip "$live_name")"
[[ -n "$next_ip" && -n "$old_ip" ]] || die "Could not resolve replacement or live container IP."

log "Redirecting direct :$public_port traffic to $next_name ($next_ip)"
handoff_ip="$next_ip"
handoff_active=true
as_root iptables -t nat -I PREROUTING 1 -p tcp --dport "$public_port" -m comment --comment rawroute_cookie_handoff -j DNAT --to-destination "${next_ip}:8080"
as_root iptables -t nat -I OUTPUT 1 -p tcp -d 127.0.0.1 --dport "$public_port" -m comment --comment rawroute_cookie_handoff -j DNAT --to-destination "${next_ip}:8080"
as_root iptables -t nat -I POSTROUTING 1 -p tcp -d "$next_ip" --dport 8080 -m comment --comment rawroute_cookie_handoff -j MASQUERADE
as_root sysctl -w net.ipv4.conf.all.route_localnet=1 >/dev/null
as_root sysctl -w net.ipv4.conf.lo.route_localnet=1 >/dev/null
wait_health "http://127.0.0.1:${public_port}${health_path}" || die "Direct-port handoff health check failed."

log "Waiting for established connections to drain from $live_name ($old_ip)"
for attempt in $(seq 1 "$drain_retries"); do
  established="$(ss -Htn state established | awk -v ip="$old_ip" '$4 == ip ":8080" || $5 == ip ":8080" {count++} END {print count + 0}')"
  [[ "$established" == "0" ]] && break
  [[ "$attempt" == "$drain_retries" ]] && die "Old container still has $established established connection(s)."
  sleep 1
done

log "Gracefully retiring the old container"
docker update --restart=no "$live_name" >/dev/null
old_retirement_started=true
docker stop --time 30 "$live_name" >/dev/null
rollback_name="${live_name}-previous-${timestamp}"
docker rename "$live_name" "$rollback_name"

log "Starting the final container on :$public_port"
docker run -d \
  --name "$live_name" \
  --env-file "$deployment_env_file" \
  --network "$rawroute_network" \
  --network-alias "$live_name" \
  -p "$public_port:8080" \
  --restart unless-stopped \
  "$image" >/dev/null
docker network connect "$dokploy_network" "$live_name"
verify_container "$live_name"

final_ip="$(container_ip "$live_name")"
cleanup_handoff "$handoff_ip"
handoff_ip="$final_ip"
as_root iptables -t nat -I PREROUTING 1 -p tcp --dport "$public_port" -m comment --comment rawroute_cookie_handoff -j DNAT --to-destination "${final_ip}:8080"
as_root iptables -t nat -I OUTPUT 1 -p tcp -d 127.0.0.1 --dport "$public_port" -m comment --comment rawroute_cookie_handoff -j DNAT --to-destination "${final_ip}:8080"
as_root iptables -t nat -I POSTROUTING 1 -p tcp -d "$final_ip" --dport 8080 -m comment --comment rawroute_cookie_handoff -j MASQUERADE

log "Switching Traefik to the final $live_name container"
set_traefik_backend "$live_name"
sleep 3
verify_traefik_backend "$live_name"
wait_health "http://127.0.0.1:${public_port}${health_path}" || die "Final direct-port health check failed."
verify_public_domains

log "Removing the temporary direct-port redirect"
cleanup_handoff "$handoff_ip"
restore_network_sysctls
wait_health "http://127.0.0.1:${public_port}${health_path}" || die "Direct-port health check failed after removing the handoff."
handoff_active=false

docker container rm --force "$next_name" >/dev/null
traefik_changed=false
log "Deployment complete. Rollback container retained as $rollback_name"
log "Traefik backup retained at $traefik_backup"
docker logs --tail 40 "$live_name"
