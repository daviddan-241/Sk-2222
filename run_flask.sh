#!/bin/sh
echo "[Agent] Starting..."
cd /home/runner/workspace/multi_agent_system
exec /home/runner/workspace/.pythonlibs/bin/gunicorn \
  --bind 0.0.0.0:5000 \
  --reuse-port \
  --workers 1 \
  --threads 4 \
  --timeout 120 \
  --keep-alive 5 \
  --worker-class gthread \
  app:app
