#!/bin/bash
# Smoke tests for model-chain-proxy — runs proxy itself
# Usage: ./test.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=0
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; rm "$DIR/models.list.test" 2>/dev/null; }
trap cleanup EXIT

# ── Use fresh port (kernel picks free one) ─────────────
PORT=18467

echo "╔═══════════════════════════════════════════╗"
echo "║   model-chain-proxy — smoke tests          ║"
echo "╠═══════════════════════════════════════════╣"
printf "║   port   : %-29s ║\n" "$PORT"
printf "║   date   : %-29s ║\n" "$(date '+%Y-%m-%d %H:%M:%S')"
echo "╚═══════════════════════════════════════════╝"

# ── Start proxy ──────────────────────────────────────────
echo ""; echo "── starting proxy ──"; echo ""
PORT="$PORT" node "$DIR/server.js" &
PID=$!
sleep 2
BASE="http://127.0.0.1:$PORT"

# ── Test helpers ──────────────────────────────────────────
PASS=0; FAIL=0; RESULTS=""

pass() { printf "  \033[32mPASS\033[0m  %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "  \033[31mFAIL\033[0m  %s — got: %s\n" "$1" "${2:0:120}"; FAIL=$((FAIL + 1)); }
ok_resp() {
  if echo "$1" | grep -qi "$2"; then pass "$3"; else fail "$3" "$1"; fi
}
sep() { echo ""; echo "── $1 ──"; }

# ── 1. Health ──────────────────────────────────────────
sep "1. Health endpoint"
H=$(curl -s --max-time 5 "$BASE/health" 2>/dev/null || echo "")
echo "$H" | grep -q '"status":"ok"' && pass "status is ok" || fail "status is ok" "$H"
echo "$H" | grep -qo '"models":[1-9]' && pass "models > 0" || fail "models > 0" "$H"
echo "$H" | grep -q '"uptime":' && pass "uptime reported" || fail "uptime" "$H"

# ── 2. Metrics (fresh state) ──────────────────────────
sep "2. Metrics (fresh state)"
M=$(curl -s --max-time 5 "$BASE/metrics" 2>/dev/null || echo "")
ok_resp "$M" "HELP proxy_requests_total" "prometheus format"
ok_resp "$M" "proxy_requests_total 0"     "zero requests"
ok_resp "$M" "proxy_errors_total 0"       "zero errors"

# ── 3. Real request ────────────────────────────────────
sep "3. Chat completions"
R=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}],"max_tokens":10}' \
  --max-time 90 2>/dev/null || echo "")
MODEL=$(echo "$R" | grep -o '"model":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$MODEL" ] && pass "got response from $MODEL" || fail "no model" "$R"
ok_resp "$R" '"choices"' "valid response"
ok_resp "$R" '"content"' "has content"
ok_resp "$R" '"usage"'   "usage reported"
if echo "$R" | grep -q '"code"'; then
  ERR=$(echo "$R" | grep -o '"code":[0-9]*' | head -1)
  fail "got error ($ERR)" "$R"
else
  pass "no error code"
fi

# ── 4. Metrics (after 1 request) ──────────────────────
sep "4. Metrics (after 1 request)"
M2=$(curl -s --max-time 5 "$BASE/metrics" 2>/dev/null || echo "")
TOTAL=$(echo "$M2" | grep "^proxy_requests_total " | awk '{print $2}')
[ "$TOTAL" = "1" ] && pass "totalRequests = 1" || fail "totalRequests = '$TOTAL'"

SERVED=$(echo "$M2" | grep "proxy_model_served_total{model=" | awk '{s+=$2} END{print s+0}')
[ "$SERVED" = "1" ] && pass "1 model served" || fail "served = $SERVED"

# ── 5. Bad request ──────────────────────────────────────
sep "5. Error handling (bad JSON)"
BAD=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{bad}' 2>/dev/null || echo "000")
[ "$BAD" = "400" ] && pass "bad JSON → 400" || fail "expected 400, got $BAD"

# ── Summary ─────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo ""
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32m✅  All %d tests passed\033[0m\n" "$TOTAL" && echo "  proxy is healthy and the fallback chain works"
else
  printf "  \033[31m❌  %d of %d tests failed\033[0m\n" "$FAIL" "$TOTAL"
fi
echo ""
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
