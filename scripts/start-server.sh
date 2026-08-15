#!/bin/sh
set -eu

exec /usr/bin/xvfb-run -a -s "-screen 0 1920x1080x24" /usr/local/bin/bun run start
