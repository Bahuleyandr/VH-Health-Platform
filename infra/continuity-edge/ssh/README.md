# SSH principal boundary

The source and central-drop accounts use different keys and different hosts or
server-side accounts.

For the source:

1. create one account for one exact tenant/facility export;
2. make its `ChrootDirectory` root-owned;
3. bind-mount only that facility publication root at `/facility` with
   `ro,nodev,nosuid,noexec`;
4. install the `Match User` block from `source-sshd_config.example`;
5. install the `from=...,restrict` public key line; and
6. prove SFTP reads `current.json` and the referenced set while write, remove,
   rename, shell, PTY, agent-forward, port-forward, and paths above
   `/facility` all fail.

`internal-sftp -R` is read-only. `ChrootDirectory`, not `-d`, is the path
boundary; `-d /facility` only selects the initial directory.

For the central drop, install the second public key with the committed
`rrsync -wo` forced command. The edge can create new batch filenames but
cannot read, list, overwrite, or delete the drop. Central operators ingest
those batches with the existing C3.2a CLI from a separate identity.

Record host keys out-of-band in the edge `ssh_known_hosts` file. Never use
`StrictHostKeyChecking=no`, `accept-new`, a user/device mTLS key, or a shared
human SSH account.
