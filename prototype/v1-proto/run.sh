#!/usr/bin/env bash
# PROTOTYPE 场景跑法：生成场景 opencode.json（占位符 → 绝对路径）+ 探针日志 + 跑 v1 opencode
# 用法: ./run.sh <scenario> ["run 参数追加"]
# 场景: s1-local-dual | s2-server-entry | s3-factory-file | s4-npm-tarball
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PKG="$ROOT/pkg"
SC="${1:?usage: run.sh <scenario>}"
shift || true

TARBALL="$ROOT/ccproto-v1-proto-0.0.1.tgz"
if [ ! -f "$TARBALL" ]; then
  (cd "$PKG" && npm pack --pack-destination "$ROOT" >/dev/null)
fi

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$SC-$(date +%s).jsonl"

DIR="$ROOT/scenarios/$SC"
CFG="$DIR/opencode.json"
if [ -f "$DIR/opencode.json.tpl" ]; then
  sed -e "s|__PKG__|$PKG|g" -e "s|__TARBALL__|$TARBALL|g" "$DIR/opencode.json.tpl" > "$CFG"
fi

echo ">>> scenario=$SC"
echo ">>> probe log: $LOG"
echo ">>> opencode.json:"; cat "$CFG"; echo

export CCPROTO_LOG="$LOG"
export CCPROTO_NPM_SPEC="file:$TARBALL"

# opencode run 按 cwd 发现项目级 opencode.json——必须在场景目录里跑
cd "$DIR"
opencode run "say pong" --model ccproto/fake-1 "$@"

echo
echo ">>> probe log:"
cat "$LOG" 2>/dev/null || echo "(no probe entries)"
