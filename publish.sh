#!/usr/bin/env bash
# 用途：本地手动发布 NPM 包与 ClawHub Skill（与 CI 行为保持一致）
# 依赖：Node.js >= 18、npm、npx

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "错误：环境变量 ${name} 未设置" >&2
    exit 1
  fi
}

publish_npm() {
  echo "==> 发布 NPM：openclaw-aicc-plugin-native"

  require_env NODE_AUTH_TOKEN

  pushd "$ROOT_DIR" >/dev/null

  npm install
  npm run build

  # 为避免污染全局 npm 配置，使用临时 userconfig 写入 Token
  local npmrc
  npmrc="$(mktemp)"
  cleanup() {
    rm -f "$npmrc"
  }
  trap cleanup EXIT

  {
    echo "registry=https://registry.npmjs.org/"
    echo "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}"
  } >"$npmrc"

  NPM_CONFIG_USERCONFIG="$npmrc" npm publish

  popd >/dev/null
}

publish_clawhub() {
  echo "==> 发布 ClawHub：skills/aicc-security-guard"

  require_env CLAWHUB_TOKEN

  pushd "$ROOT_DIR/skills/aicc-security-guard" >/dev/null
  CLAWHUB_TOKEN="$CLAWHUB_TOKEN" npx clawhub@latest publish
  popd >/dev/null
}

main() {
  publish_npm
  publish_clawhub
  echo "==> 完成"
}

main "$@"

