# Dalekdefender public edge proxy

This is the trusted public-controller shim for the single-node Dalekdefender
test deployment. Cloudflare terminates on Deltaquadrant, traverses Tailscale to
Dalekdefender port 8444, and Tailscale Serve forwards to this localhost-only
proxy on port 30093. The proxy overwrites `X-VH-Route-Kind` with `public` before
forwarding to the existing localhost backend proxy on port 30090.

The shim keeps the backend readiness contract fail-closed: callers cannot
self-assert a route kind. The full production deployment continues to use the
public ingress-nginx controller under `infra/kubernetes/base/ingress-nginx`.

Deploy from this directory on Dalekdefender:

```bash
docker compose up -d
docker compose ps
tailscale serve --bg --https=8444 http://localhost:30093
```

Rollback preserves the prior direct backend proxy:

```bash
tailscale serve --bg --https=8444 http://localhost:30090
docker compose down
```
