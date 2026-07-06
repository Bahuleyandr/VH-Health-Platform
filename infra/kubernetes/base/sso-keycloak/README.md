# HELD Admin SSO Keycloak Chart

This directory is intentionally not referenced by `infra/kubernetes/base/kustomization.yaml`.
It is a held operator bundle for NL-1 P1 admin OIDC SSO validation.

Before applying anything here:

1. Create and seal the `keycloak-admin` and database credential secrets.
2. Provision a dedicated Keycloak database in CNPG.
3. Review ingress hostname and TLS issuer.
4. Confirm tenant provider configuration is still default-off in the app.

Apply only by explicitly targeting this directory or by adding it to an overlay in a reviewed deployment PR.
