#!/bin/sh
set -eu
lab=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

docker build -t auth-app:local "$lab/auth-app"
