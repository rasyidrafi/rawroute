#!/usr/bin/env bash
# Disposable Docker-only acceptance. Never targets an existing deployment/volume.
set -euo pipefail
image="${STORAGE_SMOKE_IMAGE:-rawroute-storage-auto:verification}"
client_image="${STORAGE_SMOKE_CLIENT_IMAGE:-rawroute-storage-native:tests}"
prefix="rawroute-storage-auto-$$"
network="$prefix-network"
provider="$prefix-upstream"
temporary=$(mktemp -d /tmp/opencode/storage-startup-smoke.XXXXXX)
chmod 700 "$temporary"
containers=()
volumes=()
cleanup() {
  for container in "${containers[@]}"; do docker rm -f "$container" >/dev/null 2>&1 || true; done
  for volume in "${volumes[@]}"; do docker volume rm "$volume" >/dev/null 2>&1 || true; done
  docker network rm "$network" >/dev/null 2>&1 || true
  echo "Disposable diagnostic files retained in $temporary"
}
trap cleanup EXIT
docker network create --internal "$network" >/dev/null
containers+=("$provider")
docker run -d --name "$provider" --network "$network" -e COM_ADOBE_TESTING_S3MOCK_STORE_RETAIN_FILES_ON_EXIT=false \
  adobe/s3mock:4.10.0@sha256:b3f846f27e029a14490bf1f3f480db6fae75563cf1d847c05290282c49a85221 >/dev/null

export RAWROUTE_IMAGE="$image"
unset DEFAULT_PROXY_API_KEY DEFAULT_ADMIN_PASSWORD SESSION_SECRET
export STORAGE_S3_ALLOWED_ORIGINS="http://$provider:9090"
unset STORAGE_ENABLED STORAGE_ENCRYPTION_KEY STORAGE_S3_PORT
docker run --rm --network "$network" -e PROVIDER="http://$provider:9090" "$client_image" \
  bun -e 'for(let i=0;i<180;i++){try{await fetch(process.env.PROVIDER);process.exit(0)}catch{}await Bun.sleep(500)}process.exit(1)'

for base in docker-compose.yml docker-compose.external.yml; do
  label=managed
  if [[ "$base" == *external* ]]; then label=external; fi
  # Generate the normal base and single-opt-in configuration, without loading a
  # real .env. No additional overlay, migration command or encryption env exists.
  docker compose --env-file /dev/null -f "$base" config --format json > "$temporary/$label-base.json"
  docker compose --env-file /dev/null -f "$base" -f docker-compose.storage.yml config --format json > "$temporary/$label-storage.json"
  python3 - "$temporary" "$label" <<'PY'
import json, pathlib, sys
root, label = pathlib.Path(sys.argv[1]), sys.argv[2]
base = json.loads((root / f"{label}-base.json").read_text())["services"]["rawroute"]
enabled = json.loads((root / f"{label}-storage.json").read_text())["services"]["rawroute"]
assert not any(k.startswith("STORAGE_S3") or k in ("STORAGE_ENABLED", "STORAGE_ENCRYPTION_KEY") for k in base["environment"])
assert not any(p["target"] == 9000 for p in base["ports"])
assert enabled["environment"]["STORAGE_ENABLED"] == "true"
assert "STORAGE_ENCRYPTION_KEY" not in enabled["environment"]
assert not {"DEFAULT_ADMIN_PASSWORD", "DEFAULT_PROXY_API_KEY", "SESSION_SECRET"}.intersection(base["environment"])
assert any(p["target"] == 9000 for p in enabled["ports"])
for kind, config in (("base", base), ("storage", enabled)):
    path = root / f"{label}-{kind}.env"
    path.write_text("".join(f"{k}={v}\n" for k, v in config["environment"].items()))
    path.chmod(0o600)
PY
  for scenario in fresh upgrade; do
    app="$prefix-$label-$scenario"
    data="$app-data"
    state="$app-client"
    containers+=("$app")
    volumes+=("$data" "$state")
    docker volume create "$data" >/dev/null
    docker volume create "$state" >/dev/null
    start() {
      docker run -d --name "$app" --network "$network" --mount "type=volume,source=$data,target=/data" \
        --env-file "$temporary/$label-$1.env" -e RAWROUTE_PUBLIC_URL="http://$app:8080" "$image" >/dev/null
      docker exec "$app" bun -e 'for(let i=0;i<180;i++){try{if((await fetch("http://127.0.0.1:8080/api/live")).ok)process.exit(0)}catch{}await Bun.sleep(500)}process.exit(1)'
      if [[ "$label" == managed ]]; then
        docker exec "$app" bun -e 'const response=await fetch("http://127.0.0.1:8080/api/health");if(!response.ok)throw Error("Managed AI/database health degraded: "+await response.text())'
      fi
    }
    if [[ "$scenario" == upgrade ]]; then
      start base
      docker exec -i "$app" bun - <<'JS'
import {Database} from 'bun:sqlite';
import {readdirSync} from 'node:fs';
const db = new Database('/data/rawroute.sqlite');
if(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'storage_%'").get())throw Error('Default created Storage schema');
if(readdirSync('/data').some(n=>n.includes('storage-key')||n.endsWith('.bak')))throw Error('Default created key/backup');
try{await fetch('http://127.0.0.1:9000');throw Error('Unexpected listener')}catch(e){if(e.message==='Unexpected listener')throw e}
db.run("INSERT INTO rawroute_documents(path,collection_path,document_id,data) VALUES('TEST_ai/sentinel','TEST_ai','sentinel','{\"preserved\":42}')");
db.close();
console.log('PASS default AI-only boot: no Storage listener/key/schema/backup');
JS
      docker stop -t 45 "$app" >/dev/null
      docker rm "$app" >/dev/null
    fi
    start storage
    phase() {
      docker run --rm --network "$network" --mount "type=volume,source=$state,target=/smoke" \
        -e STORAGE_SMOKE_DISPOSABLE=yes -e STORAGE_SMOKE_ADMIN_URL="http://$app:8080" \
        -e STORAGE_SMOKE_S3_URL="http://$app:9000" -e STORAGE_SMOKE_UPSTREAM_URL="http://$provider:9090" \
        -w /app "$client_image" bun --no-env-file tests/diagnostics/storage-native-smoke.ts "$1"
    }
    phase prepare
    key_before=$(docker exec "$app" bun -e 'console.log(new Bun.CryptoHasher("sha256").update(await Bun.file("/data/rawroute.sqlite.storage-key").arrayBuffer()).digest("hex"))')
    docker restart -t 45 "$app" >/dev/null
    phase recover
    key_after=$(docker exec "$app" bun -e 'console.log(new Bun.CryptoHasher("sha256").update(await Bun.file("/data/rawroute.sqlite.storage-key").arrayBuffer()).digest("hex"))')
    test "$key_before" = "$key_after"
    docker exec -e SCENARIO="$scenario" -i "$app" bun - <<'JS'
import {Database} from 'bun:sqlite';
import {readdirSync,statSync} from 'node:fs';
const db=new Database('/data/rawroute.sqlite',{readonly:true});
const backups=readdirSync('/data').filter(n=>n.endsWith('.bak'));
if((statSync('/data/rawroute.sqlite.storage-key').mode&0o777)!==0o600)throw Error('Unsafe key permissions');
if(backups.length!==(process.env.SCENARIO==='upgrade'?1:0))throw Error('Unexpected backups: '+backups.length);
if(process.env.SCENARIO==='upgrade'){
  const original=new Database('/data/'+backups[0],{readonly:true});
  for(const connection of [original,db])if(connection.query("SELECT data FROM rawroute_documents WHERE path='TEST_ai/sentinel'").get()?.data!=='{"preserved":42}')throw Error('AI data lost');
  if(original.query("SELECT name FROM sqlite_master WHERE name='storage_schema'").get())throw Error('Backup includes migrated schema');
  original.close();
}
db.close();
console.log('PASS automatic setup/restart, stable restricted key, backup count and preserved AI data');
JS
    docker logs "$app" > "$temporary/$label-$scenario.log" 2>&1
    docker rm -f "$app" >/dev/null
    echo "PASS $label $scenario single-overlay automatic Storage smoke"
  done
done
