#!/usr/bin/env bash
# Aegis Gateway - Latency & Overhead Benchmark Script

GATEWAY_URL=${1:-"http://localhost:8788"}
VIRTUAL_KEY=${2:-"sk-aegis-root-master-key"}

echo "=========================================================="
echo " 🛡️  Aegis AI Gateway - Latency & Caching Benchmark"
echo " Target: ${GATEWAY_URL}"
echo "=========================================================="

echo ""
echo "[1/3] Testing Cold Proxy Request..."
curl -s -w "\nHTTP Status: %{http_code}\nTotal Time: %{time_total}s\n" \
  -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${VIRTUAL_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "aegis-auto",
    "messages": [{"role": "user", "content": "Benchmark test query 1: Explain semantic caching."}],
    "stream": false
  }'

echo ""
echo "[2/3] Testing Semantic Cache Hit (Sub-15ms expected)..."
curl -s -w "\nHTTP Status: %{http_code}\nTotal Time: %{time_total}s\n" \
  -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${VIRTUAL_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "aegis-auto",
    "messages": [{"role": "user", "content": "Benchmark test query 1: Explain semantic caching."}],
    "stream": false
  }'

echo ""
echo "[3/3] Checking Gateway Health & Memory Overhead..."
curl -s "${GATEWAY_URL}/health" | jq .

echo ""
echo "Benchmark completed."
