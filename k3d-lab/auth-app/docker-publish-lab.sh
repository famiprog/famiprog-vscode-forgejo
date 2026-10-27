#!/bin/sh
set -eu
lab=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

k3d image import auth-app:local -c forgejo-lab
k3d kubeconfig write forgejo-lab --output "$lab/kubeconfig.yml" --overwrite >/dev/null
export KUBECONFIG="$lab/kubeconfig.yml"
kubectl apply -f "$lab/manifests/auth-app.yml"
kubectl rollout restart deployment/auth-app
kubectl rollout status deployment/auth-app --timeout=120s
