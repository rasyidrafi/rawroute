# Production on a 1 GB VM

Use Podman 5 or newer with systemd and cgroup v2. The service files run rootful
containers and enforce memory limits through systemd. Only RawRoute is published,
on `127.0.0.1:8080`. An optional systemd socket proxy also serves `[::1]:8080`.
PostgreSQL, Redis, and CLIProxyAPI remain on the private container network.

## Build and publish

[Production image](https://github.com/rasyidrafi/rawroute/actions/workflows/production-image.yml)
runs on changes pushed to `main` and through manual dispatch. It installs Bun 1.4.2,
runs lint and unit tests, builds the production image with TypeScript checking,
and publishes to [Docker Hub](https://hub.docker.com/r/rasyidrafi/rawroute).
Browser tests are not part of this workflow.

The repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` authenticate the
publisher. Images have `latest` and `sha-<full-commit>` tags. Build on GitHub rather
than this VM; compilation and typechecking can use more RAM than the running stack.

```bash
gh workflow run production-image.yml --ref main
gh run list --workflow production-image.yml --limit 5
```

## First installation

Clone the repository and install Bun 1.4.2 for the one-time credential generator.
It needs no package installation. It creates private files and refuses to replace
existing credentials.

```bash
bun scripts/init-production.ts
sudo install -d -m 700 /etc/rawroute
sudo install -m 600 .rawroute/app.env .rawroute/postgres.env .rawroute/cliproxy.env .rawroute/cliproxy.yaml /etc/rawroute/
sudo install -d /etc/containers/systemd
sudo install -m 644 deploy/podman/*.container deploy/podman/*.network deploy/podman/*.volume /etc/containers/systemd/
```

The generated configuration uses `http://localhost:8080`. The login name is `admin`;
read its password from `.rawroute/app.env` privately. Keep `/etc/rawroute` and
`.rawroute` out of source control and backups intended for public sharing.

Pull images sequentially before starting services. Replace `latest` with a
verified `sha-<commit>` tag or digest in `/etc/containers/systemd/rawroute.container`
to pin the application release. Pin dependency images there too when managing upgrades.

```bash
sudo podman pull docker.io/library/postgres:16-alpine
sudo podman pull docker.io/library/redis:7-alpine
sudo podman pull docker.io/eceasy/cli-proxy-api:latest
sudo podman pull docker.io/rasyidrafi/rawroute:latest
sudo systemctl daemon-reload
sudo systemctl start rawroute-postgres.service
sudo systemctl start rawroute-redis.service
sudo systemctl start rawroute-cliproxy.service
sudo systemctl start rawroute.service
```

Quadlet generates boot startup links from the `[Install]` sections. The `.container`
units do not need `systemctl enable`. PostgreSQL data and CLIProxyAPI credentials
live in named Podman volumes and survive container replacement. No provider
credentials are seeded; add an account or provider through the dashboard.

For IPv6 localhost access, install the socket proxy. It avoids depending on
IPv6 loopback NAT support in the host's container firewall.

```bash
sudo install -m 644 deploy/podman/rawroute-loopback.socket deploy/podman/rawroute-loopback.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rawroute-loopback.socket
```

## Memory budget

| Service | RAM ceiling | Configuration |
| --- | --- | --- |
| RawRoute | 320 MiB | Bun `--smol`, page modules loaded on demand, database pool of 4 |
| PostgreSQL | 160 MiB | 32 MiB shared buffers, 20 connections, 1 MiB work memory |
| CLIProxyAPI | 128 MiB | Go memory target of 80 MiB, one CPU worker |
| Redis | 48 MiB | 24 MiB data cap, no persistence, no eviction |
| Optional IPv6 proxy | 16 MiB | Socket activation |

The main containers can each use up to 64 MiB of swap. These are ceilings, not
reservations or throughput guarantees. Keep RAM available for the OS and SSH.
Bounded Redis writes can fail when full; callers fall back to their existing
best-effort cache behavior. Live coordination keys are not evicted to make room.
Container logs are capped at 10 MB each. CLIProxyAPI file logging is disabled.

Run maintenance jobs and checks one at a time. Avoid development servers,
local builds, and browser automation on this VM. Larger datasets and more
concurrent requests may require a larger VM or external PostgreSQL.

## Verified deployment

On 2026-09-06, image revision `33190c9` ran on this Debian VM with 853 MiB of
usable RAM. After login, dashboard rendering, and 100 mixed health/workspace
requests at concurrency four, the services used 160 MiB combined and the VM had
386 MiB available. Every request succeeded; the slowest took 196 ms.

IPv4 and IPv6 localhost health passed. A created workspace survived PostgreSQL
and app restarts, and systemd recovered the app after a forced process failure.
These checks used a fresh database and local administrative endpoints. Provider
inference requires configured credentials and has not been load-tested. Browser
testing remains manual.

## Verification and recovery

```bash
curl --max-time 5 -fsS http://127.0.0.1:8080/api/health
curl --noproxy '*' --max-time 5 -g -fsS 'http://[::1]:8080/api/health'
sudo podman ps
sudo systemctl show rawroute.service -p MemoryCurrent -p MemoryMax -p NRestarts
sudo podman logs --tail 50 rawroute
```

Health must report all dependencies as true. The app may report 503 briefly on
startup while its database and cache connect. PostgreSQL and Redis restart after
repeated failed health checks. Application process failures restart through
systemd; dependency health failures alone do not repeatedly restart the app.

For upgrades, wait for CI to pass, pull the selected image, update `Image=` in the
app's Quadlet, reload systemd, restart `rawroute.service`, and verify health.
This replaces the app with a brief service interruption. Keep the previous image
until verification finishes; point `Image=` back to it to roll back. Never run
`podman volume rm` or volume pruning as part of an upgrade.

Before upgrades, keep an off-VM backup of PostgreSQL, `/etc/rawroute`, and the
CLIProxyAPI auth volume. Database dumps and auth archives contain private data.

```bash
umask 077
sudo podman exec rawroute-postgres pg_dump -U rawroute -d rawroute -Fc > rawroute-postgres.dump
sudo podman volume export rawroute-cliproxy-auth > rawroute-cliproxy-auth.tar
```

To access a localhost-only installation from another computer, use an SSH tunnel:

```bash
ssh -L 8080:127.0.0.1:8080 your-user@your-vm
```

Open `http://localhost:8080` on that computer. Public deployment requires a TLS
reverse proxy and a matching `RAWROUTE_PUBLIC_URL`; do not expose PostgreSQL,
Redis, or CLIProxyAPI management ports.
