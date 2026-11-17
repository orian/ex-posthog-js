# Pinned toolchain for dist/recorder.js: PostHog's rrweb fork (TypeScript),
# bundled and minified with esbuild. Not Closure-compiled: see
# third_party/posthog-rrweb/README.md.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

ARG ESBUILD_VERSION=0.25.12
WORKDIR /opt/toolchain
RUN npm install --no-audit --no-fund --save-exact "esbuild@${ESBUILD_VERSION}" \
 && node -e "console.log('esbuild', require('esbuild').version)"
ENV NODE_PATH=/opt/toolchain/node_modules
WORKDIR /work
ENTRYPOINT ["node"]
