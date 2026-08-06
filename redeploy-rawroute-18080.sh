#!/usr/bin/env bash
set -Eeuo pipefail

cd /home/rizky/projects/rawroute

TRAEFIK_FILE="/etc/dokploy/traefik/dynamic/rawroute.yml"
BACKUP_FILE="/etc/dokploy/traefik/dynamic/rawroute.yml.bak-before-rawroute-redeploy"
ENV_FILE="/tmp/rawroute.env"

wait_health() {
  for _ in {1..30}; do
    curl -fsS --max-time 3 "$1" >/dev/null && return 0
    sleep 1
  done
  return 1
}

verify_domains() {
  for domain in \
    rawroute.halodev.dpdns.org \
    ccs.halodev.dpdns.org \
    api.ccs.halodev.dpdns.org \
    dashboard.ccs.halodev.dpdns.org \
    9router.halodev.dpdns.org \
    ccs.halotec.my.id \
    api.ccs.halotec.my.id \
    dashboard.ccs.halotec.my.id
  do
    curl -kfsS --max-time 10 "https://$domain/api/health" >/dev/null
    echo "$domain OK"
  done
}

echo "Building image..."
docker build -t rawroute:latest .

echo "Copying live environment..."
if docker inspect rawroute-preflight >/dev/null 2>&1; then
  docker inspect rawroute-preflight \
    --format '{{range .Config.Env}}{{println .}}{{end}}' > "$ENV_FILE"
else
  echo "rawroute-preflight not running; using .env.local"
  cp "$(dirname "$0")/.env.local" "$ENV_FILE"
fi

echo "Saving Traefik configuration..."
sudo cp "$TRAEFIK_FILE" "$BACKUP_FILE"

echo "Starting new container on temporary port..."
docker rm -f rawroute-next >/dev/null 2>&1 || true

docker run -d \
  --name rawroute-next \
  --env-file "$ENV_FILE" \
  --network dokploy-network \
  --network-alias rawroute-next \
  -p 18081:8080 \
  rawroute:latest >/dev/null

wait_health http://127.0.0.1:18081/api/health

echo "Switching Traefik to new container..."
sudo sed -i \
  's#url: http://rawroute-preflight:8080#url: http://rawroute-next:8080#' \
  "$TRAEFIK_FILE"

sleep 3
verify_domains

echo "New container is serving public traffic."
echo "Moving replacement onto port 18080..."

docker rm -f rawroute-preflight >/dev/null

docker run -d \
  --name rawroute-preflight \
  --env-file "$ENV_FILE" \
  --network dokploy-network \
  --network-alias rawroute-preflight \
  -p 18080:8080 \
  rawroute:latest >/dev/null

wait_health http://127.0.0.1:18080/api/health

echo "Switching Traefik back to port 18080 container..."
sudo sed -i \
  's#url: http://rawroute-next:8080#url: http://rawroute-preflight:8080#' \
  "$TRAEFIK_FILE"

sleep 3
verify_domains

echo "Removing temporary container..."
docker rm -f rawroute-next >/dev/null

echo "Final container logs:"
docker logs --tail 40 rawroute-preflight

echo "Deployment completed successfully."
