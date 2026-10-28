#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

docker build -f "$root/vscode-web-docker/Dockerfile" -t vscode-web "$root"
