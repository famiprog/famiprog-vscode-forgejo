# famiprog-vscode-forgejo

Explanation of dirs/files:
* `extension` - The main deliverable. VS Code extension that "talks" to a Forgejo server via API.
  * `src/web-index-html` - This is not code for the extension; but for the `index.html` (e.g. from project `vscode-web-base`) that load VS Code web + our extension.
* `forgejo-tests` - "docker compose" that starts a local Forgejo server. Used for dev and test.
  * `volume-data` - `.gitignore`d; the volume for the "docker compose". Also used for `k3d-lab`.
  * `run.mjs`
    * `./run.mjs --run` - Runs the "docker compose".
    * The following: make sure the container IS NOT started. Motivation? Useful for testing to have a "known" state. Although, the tests are in "record" mode. I.e. on first run they record in `extension/src/node/test/recordings`. Next runs => the HTTP dialog is replayed. So no need to have this container running.
    * `./run.mjs --backup` - Archives `volume-data` -> `volume-data.tar.gz`.
    * `./run.mjs --restore` - Opposite: `volume-data.tar.gz` -> `volume-data`. 
  * `index.html` - Similar to `vscode-web-base/index.html`. Integrated in the Forgejo "docker compose" for a lighter web dev loop.
* `vscode-web-base` - A web server should serve this, which contains:
  * `node_modules/@github1s/vscode-web` - A VS Code Web server, from https://github.com/conwnet/github1s/tree/master/vscode-web.
  * `famiprog-vscode-forgejo` - A symlink to `extension`. 
  * `index.html` - Boostraps the 2 above.
  * This content can be served in 3 modes:
    * via `package.json > script serve` - opens a local web server (on port 3002)
    * via `package.json > script gh-pages` - which copies to sibling dir `famiprog-vscode-forgejo-gh-pages`, which is the same Git repo, but checked out at branch https://github.com/famiprog/famiprog-vscode-forgejo/tree/gh-pages. This is a "GitHub Pages" branch; it's content is served at https://famiprog.github.io/famiprog-vscode-forgejo/
    * cf. bullet below
* `vscode-web-docker`
  * `docker-build.sh` - Creates a docker image w/ a basic web server (nginx) and files from `vscode-web-base`.
  * `docker-run.sh` - Runs that image on host port 3002.
  * `docker-publish-lab.sh` - Loads that image into the k3d lab, applies the manifest, and restarts the deployment.
* `k3d-lab` - A kubernetes setup using https://k3d.io that combines:
  * `manifests`
    * `index-html.yml` - At http://127.0.0.1:8080/, a welcome page.
    * `auth-app.yml` - At http://127.0.0.1:8080/auth-app/, a sample app that simulates the "boss" app that embeds Forgejo and VS Code web. It's in charge of auth. It has its login mechanism, based on a cookie. This kube setup makes that:
      * when pages are served from Forgejo
      * a URL is accessed from `auth-app` asking: who is the current user? The app looks at the cookie and answers
      * this current user is injected as a HTTP header; so Forgejo will consider that user logged in. Bypassing its login. The API does this too (`ENABLE_REVERSE_PROXY_AUTHENTICATION_API`); otherwise a private repo answers 404.
    * `forgejo.yml` - At http://127.0.0.1:8080/forgejo/, a Forgejo server. Similar to `forgejo-tests`. Uses the same volume.
    * `vscode-web.yml` - At http://127.0.0.1:8080/vscode-web/, a VS Code web + our extension.
  * `auth-app` - The code of `auth-app`: `.js` and `Dockerfile`.
    * `docker-build.sh`, `docker-publish-lab.sh`: idem cf. `vscode-web-docker`.

# k3d-lab: instructions

Run these from `k3d-lab`. The `kubectl apply` steps use `KUBECONFIG` from the shell. I.e. the step `export KUBECONFIG=...` should have happened.

## Create the cluster.

```bash
k3d cluster create --config k3d.yaml
```

## Kubeconfig

Cf. message at the end of cluster install:

```bash
export KUBECONFIG=$(k3d kubeconfig write forgejo-lab)
kubectl cluster-info
```

An alternative way would be:

```bash
k3d kubeconfig write forgejo-lab --output kubeconfig.yml --overwrite
export KUBECONFIG="$PWD/kubeconfig.yml"
```

## Install ingress-nginx

`controller-v1.15.1`. Traefik is disabled in `k3d.yaml` because the Forgejo Ingress uses nginx annotations.

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.15.1/deploy/static/provider/cloud/deploy.yaml
```

Wait until the admission webhook has an endpoint. Applying an Ingress before that fails.

```bash
kubectl get endpoints -n ingress-nginx ingress-nginx-controller-admission
```

Repeat until `ENDPOINTS` shows an IP.

# Install the apps

## For `manifests/index-html.yml`

```bash
kubectl apply -f manifests/index-html.yml
```

## For `manifests/auth-app.yml`

`docker-build.sh` builds `auth-app:local`. `docker-publish-lab.sh` loads that image into k3d (it is not pushed to a registry), applies the manifest, and restarts the deployment.

```bash
./auth-app/docker-build.sh
./auth-app/docker-publish-lab.sh
```

## For `manifests/forgejo.yml`

```bash
kubectl apply -f manifests/forgejo.yml
```

## For `manifests/vscode-web.yml`

```bash
../vscode-web-docker/docker-build.sh
../vscode-web-docker/docker-publish-lab.sh
```