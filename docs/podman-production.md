# Production with Podman

Use Podman 5+, systemd, and cgroup v2. Run a single RawRoute process with its
SQLite file in a persistent volume. CLIProxyAPI and optional Executor remain on
the private container network; only RawRoute publishes port 8080.

Choose managed or external CLIProxy ownership before installing units. See
[managed CLIProxyAPI](managed-cliproxy.md) for managed mode and auth-file import.
Do not install both `rawroute.container` and `rawroute-managed.container`: both
claim the same container name and host port.

## Installation

Generate credentials using Bun, then install the selected units:

```bash
bun scripts/init-production.ts
sudo install -d -m 700 /etc/rawroute
sudo install -m 600 .rawroute/app.env .rawroute/cliproxy.env .rawroute/cliproxy.yaml .rawroute/executor.env /etc/rawroute/
sudo install -d /etc/containers/systemd
sudo install -m 644 deploy/podman/rawroute.network deploy/podman/*.volume /etc/containers/systemd/
# External CLIProxy mode:
sudo install -m 644 deploy/podman/rawroute.container deploy/podman/rawroute-cliproxy.container /etc/containers/systemd/
sudo systemctl daemon-reload
sudo systemctl start rawroute-cliproxy.service rawroute.service
```

For managed mode install `rawroute-managed.container` instead, set
`CLIPROXY_MODE=managed` in `app.env`, and do not install the external CLIProxy
unit. SQLite uses `/data/rawroute.sqlite`. The named volume survives container
replacement. Protect configuration, SQLite data, and CLIProxy auth volumes as
secrets. Change the initial dashboard password before administering providers.

Executor is optional. Install its unit only if needed, configure its private API
key in `app.env`, and start `rawroute-executor.service` explicitly.

## Operations

The production workflow runs lint, types, unit and browser tests before publishing
images. Pin a verified image digest or `sha-<commit>` tag in the Quadlet. Reload
systemd and restart the selected RawRoute unit to deploy it, then check:

```bash
curl --max-time 5 -fsS http://127.0.0.1:8080/api/health
sudo podman logs --tail 50 rawroute
sudo systemctl show rawroute.service -p MemoryCurrent -p MemoryMax -p NRestarts
```

The external RawRoute unit caps memory at 320 MiB; managed mode caps the combined
processes at 448 MiB. These are ceilings, not measured throughput guarantees.
Runtime cache values are bounded to 4096 entries and 16 MiB. Live coordination
leases have a separate 4096-entry ceiling and reject new work when full rather
than evicting an owner. Runtime state, including pending OAuth sessions, resets
when the application restarts. Do not scale to multiple application processes:
coordination is process-local.

## Backups and recovery

Stop RawRoute before exporting its data volume, so the SQLite database and WAL
are consistent. Back up `/etc/rawroute` and the CLIProxy auth volume too. Example
for external mode:

```bash
umask 077
sudo systemctl stop rawroute.service
sudo podman volume export rawroute-managed-data > rawroute-data.tar
sudo podman volume export rawroute-cliproxy-auth > rawroute-auth.tar
sudo systemctl start rawroute.service
```

In managed mode stop `rawroute-managed.service`; its data volume also contains
CLIProxy state. Keep an off-VM backup. Never remove or prune data volumes as part
of deployment. Roll back application images only when their SQLite schema is
compatible. No old-storage conversion or runtime fallback is provided.

Use restrictive firewall rules and a TLS reverse proxy with a matching
`RAWROUTE_PUBLIC_URL`. Never expose CLIProxy management ports publicly.
