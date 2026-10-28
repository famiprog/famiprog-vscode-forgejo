#!/bin/sh
set -eu

version=$(node -p 'require("./package.json").version')
docker tag auth-app:local cristianspiescu/auth-app:${version}
docker push cristianspiescu/auth-app:${version}