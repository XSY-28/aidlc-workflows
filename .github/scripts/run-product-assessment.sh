#!/usr/bin/env bash
set -euo pipefail

# The existing runtime setup owns the separate OS account, read-only checkout,
# private config and provider environment. Only its restricted read tools run.
output_dir="$(sudo -u ai-pr-review mktemp -d -t aidlc-product.XXXXXX)"
trap 'sudo find "$output_dir" -depth -delete' EXIT
schema="$(jq -c . .aida-product-controls/prompts/ai-product-decision-schema.json)"
prompt="$(cat .aida-product-controls/prompts/ai-product-decision.md)"
claude_bin="$(command -v claude)"
sudo -u ai-pr-review -- timeout --signal=TERM --kill-after=30s 15m \
  env \
  ANTHROPIC_MODEL="$FABLE_MODEL" \
  AWS_REGION="$AWS_REGION" \
  CLAUDE_CODE_USE_BEDROCK=1 \
  CLAUDE_CONFIG_DIR=/home/ai-pr-review/.claude-review \
  HOME=/home/ai-pr-review \
  /bin/bash -c \
  'output="$1"; shift; exec "$@" >"$output" 2>/dev/null' \
  bash "$output_dir/result.json" \
  "$claude_bin" --bare --restricted --print "$prompt" \
  --model "$FABLE_MODEL" --effort high --output-format json --json-schema "$schema" \
  --no-session-persistence --disable-slash-commands --strict-mcp-config \
  --permission-mode dontAsk --permission-prompts none --tools "Read,Glob,Grep"

sudo -u ai-pr-review -- /bin/bash -c \
  'jq -c -e ".structured_output | select(type == \"object\")" "$1" >"$2"' \
  bash "$output_dir/result.json" "$output_dir/assessment.json"
size="$(sudo -u ai-pr-review stat -c %s "$output_dir/assessment.json")"
if [ "$size" -gt 50000 ]; then
  echo "Product assessment exceeds the output limit" >&2
  exit 1
fi
sudo -u ai-pr-review -- perl -i -pe \
  's/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/[REDACTED-AWS-KEY-ID]/g; s/(?i)(aws_access_key_id|aws_secret_access_key|aws_session_token|x-amz-security-token)\s*[:=]\s*\S+/$1=[REDACTED]/g' \
  "$output_dir/assessment.json"
sudo install -m 640 -o runner -g ai-pr-review "$output_dir/assessment.json" .ai-review-context/product-assessment.json
