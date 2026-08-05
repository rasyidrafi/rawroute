<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## RawRoute Deployment

- Treat the live `rawroute` container on `:8080` as production traffic. Never run `docker stop`, `docker restart`, or `docker rm -f rawroute` during deployment.
- Build the image first: `docker build -t rawroute:latest .`.
- Copy the live environment without printing it: `docker inspect rawroute --format '{{range .Config.Env}}{{println .}}{{end}}' > /tmp/rawroute.env`.
- Start a separate preflight container on `:18080` with the same environment: `docker run -d --name rawroute-preflight --env-file /tmp/rawroute.env -p 18080:8080 rawroute:latest`.
- Require `curl --retry 10 --retry-delay 1 --retry-connrefused -fsS http://127.0.0.1:18080/api/health`, browser verification, and `docker logs rawroute-preflight` before any handoff.
- Remove only the preflight container after verification: `docker rm -f rawroute-preflight`.
- For this direct Docker binding, create a latest-image preflight on `18080` using `--env-file .env.local`, verify health and browser behavior, then add temporary IPv4/IPv6 `nat` PREROUTING and loopback OUTPUT redirects from `8080` to `18080` while the old container remains running.
- Verify the redirect, wait until the old container has no established client connections, set its restart policy to `no`, stop it gracefully, and rename/remove it only after traffic is served by preflight.
- Start the latest image as `rawroute` on `8080` with `--env-file .env.local --restart unless-stopped`, verify the new container directly by its container IP, remove the temporary redirects, verify IPv4/IPv6 health, then remove the preflight container.
- Never remove or stop the live container before traffic has been redirected and drained; a direct Docker rebind without this handoff causes downtime.
