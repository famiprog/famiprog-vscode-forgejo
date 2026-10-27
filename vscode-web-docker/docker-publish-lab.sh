#!/bin/sh
set -eu
lab=$(CDPATH= cd -- "$(dirname "$0")/../k3d-lab" && pwd)

k3d image import vscode-web -c forgejo-lab
k3d kubeconfig write forgejo-lab --output "$lab/kubeconfig.yml" --overwrite >/dev/null
export KUBECONFIG="$lab/kubeconfig.yml"
kubectl apply -f "$lab/manifests/vscode-web.yml"
kubectl rollout restart deployment/vscode-web
kubectl rollout status deployment/vscode-web --timeout=120s
