#!/bin/sh
set -eu

version=$(node -p 'require("../extension/package.json").version')
docker tag vscode-web:latest cristianspiescu/vscode-web:${version}
docker push cristianspiescu/vscode-web:${version}