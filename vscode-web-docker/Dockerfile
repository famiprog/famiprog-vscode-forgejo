# Static host for vscode-web-base/index.html.
# Layout matches `yarn serve` in vscode-web-base:
#   /node_modules/@github1s/vscode-web/...
#   /famiprog-vscode-forgejo/...
#
# From vscode-web-docker (the build context is still the repo root):
#   ./docker-build.sh
#   docker run --rm -p 3002:3002 vscode-web
# Then open http://localhost:3002 (the OAuth redirect in index.html).

FROM node:22-bookworm-slim AS build

WORKDIR /src

# cache zone: 1/ the vscode-web lib
COPY vscode-web-base/package.json vscode-web-base/yarn.lock ./vscode-web-base/
RUN yarn --cwd vscode-web-base install --frozen-lockfile --production

# 2/ the libs of our ext
COPY extension/package.json extension/yarn.lock extension/.yarnrc ./extension/
RUN yarn --cwd extension install --frozen-lockfile

# now copy the rest (i.e. source files)
COPY extension ./extension
WORKDIR /src/extension
RUN yarn package-web

FROM nginx:1.27-alpine

COPY vscode-web-docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY vscode-web-base/index.html /usr/share/nginx/html/index.html
COPY --from=build /src/vscode-web-base/node_modules/@github1s/vscode-web /usr/share/nginx/html/node_modules/@github1s/vscode-web
COPY --from=build /src/extension/package.json /usr/share/nginx/html/famiprog-vscode-forgejo/package.json
COPY --from=build /src/extension/dist /usr/share/nginx/html/famiprog-vscode-forgejo/dist

EXPOSE 3002
