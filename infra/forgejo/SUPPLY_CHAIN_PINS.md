# Historical Forgejo supply-chain record

Forgejo delivery and mirroring were permanently retired by the owner on
2026-09-30. The workflows, runner image and provider-specific BuildKit helper
described by earlier revisions of this file are no longer active. Their
historical definitions remain in Git; do not restore them or provision a
replacement Forgejo runner.

Current immutable-input requirements are documented in
[`docs/WORKFLOW_SUPPLY_CHAIN_PINS.md`](../../docs/WORKFLOW_SUPPLY_CHAIN_PINS.md).
The coverage mapping and unresolved external containment requirements are in
[`docs/FORGEJO_RETIREMENT.md`](../../docs/FORGEJO_RETIREMENT.md).

`signing/cosign.pub` remains historical artifact-verification evidence. Retaining
it neither authorizes new signing nor grants permission to remove a live key,
shared runner, remote job, credential, image or backup.
