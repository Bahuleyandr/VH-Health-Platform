# Admin OIDC Keycloak Fixture

This fixture is for local, operator-run validation of NL-1 P1 admin-realm OIDC SSO.
It is not used by CI.

Start Keycloak:

```bash
docker compose -f infra/keycloak/admin-oidc/docker-compose.yml up -d
```

Local realm defaults:

- Issuer: `http://127.0.0.1:18080/realms/vh-admin`
- Discovery URL: `http://127.0.0.1:18080/realms/vh-admin/.well-known/openid-configuration`
- Client ID: `vh-admin`
- Client secret: `dev-only-not-a-real-secret`
- Group claim: `groups`
- Admin group: `vh-admins`
- Smoke user: `admin.sso@example.com`

Before running the smoke script, configure a tenant admin OIDC provider in VH Health with provider key `keycloak`, map group `vh-admins` to `ADMIN`, and make sure an existing `admins` row matches `admin.sso@example.com`. The SSO broker intentionally does not create admins.
