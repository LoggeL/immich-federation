#!/bin/sh
# Starts as root only to make DATA_DIR writable for the unprivileged "node" user (uid 1000),
# e.g. when Docker created a bind-mount directory as root:root. Then drops privileges.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if ! su-exec node:node test -w "$DATA_DIR"; then
    echo "immich-federation: $DATA_DIR gehört nicht UID 1000 – setze Eigentümer (chown -R 1000:1000)" >&2
    chown -R node:node "$DATA_DIR" || true
  fi
  exec su-exec node:node "$@"
fi
exec "$@"
