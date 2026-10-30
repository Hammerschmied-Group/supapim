#!/usr/bin/env bash
# Stop the stack, keep data.
source "$(dirname "$0")/lib.sh"
need_env
compose down
