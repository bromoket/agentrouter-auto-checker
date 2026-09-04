#!/bin/sh
set -eu

if [ -n "${XVFB_DISPLAY:-}" ] || [ -n "${XVFB_AUTH_FILE:-}" ]; then
    if [ -z "${XVFB_DISPLAY:-}" ] || [ -z "${XVFB_AUTH_FILE:-}" ]; then
        echo "XVFB_DISPLAY and XVFB_AUTH_FILE must be set together" >&2
        exit 64
    fi

    case "$XVFB_DISPLAY" in
        *[!0-9]*|'')
            echo "XVFB_DISPLAY must be an unsigned display number" >&2
            exit 64
            ;;
    esac

    exec /usr/bin/xvfb-run \
        -n "$XVFB_DISPLAY" \
        -f "$XVFB_AUTH_FILE" \
        -s "-screen 0 1920x1080x24" \
        /usr/local/bin/bun run start
fi

exec /usr/bin/xvfb-run -a -s "-screen 0 1920x1080x24" /usr/local/bin/bun run start
