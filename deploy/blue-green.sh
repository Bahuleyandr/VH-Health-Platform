#!/bin/bash
# Blue/Green deployment script
# Deploys new version alongside existing, switches traffic after health check
#
# Usage: ./blue-green.sh [current_color]
#   current_color: "blue" or "green" (default: blue)

set -euo pipefail

CURRENT_COLOR="${1:-blue}"
NEW_COLOR=$([ "$CURRENT_COLOR" = "blue" ] && echo "green" || echo "blue")
NEW_PORT=$([ "$NEW_COLOR" = "blue" ] && echo "5000" || echo "5001")

echo "=== VH Health Blue/Green Deployment ==="
echo "Current: $CURRENT_COLOR"
echo "Deploying: $NEW_COLOR on port $NEW_PORT"
echo ""

# Start new instance
echo "Starting $NEW_COLOR instance..."
PORT=$NEW_PORT docker compose -f docker-compose.yml -f "docker-compose.$NEW_COLOR.yml" up -d api

# Wait for health check
for i in {1..30}; do
  if curl -sf "http://localhost:$NEW_PORT/" > /dev/null 2>&1; then
    echo "$NEW_COLOR is healthy"

    # Switch traffic (update nginx upstream)
    echo "upstream backend { server 127.0.0.1:$NEW_PORT; }" > /etc/nginx/conf.d/backend-upstream.conf
    nginx -s reload
    echo "Traffic switched to $NEW_COLOR"

    # Drain connections from old instance
    OLD_PORT=$([ "$CURRENT_COLOR" = "blue" ] && echo "5000" || echo "5001")
    echo "Draining connections on $CURRENT_COLOR (port $OLD_PORT)..."
    sleep 5

    # Record active deployment color
    echo "$NEW_COLOR" > /var/run/vhhealth-active-color

    echo ""
    echo "=== Deployment complete ==="
    echo "Active: $NEW_COLOR (port $NEW_PORT)"
    echo "Previous: $CURRENT_COLOR (port $OLD_PORT) — stop manually when ready"
    exit 0
  fi
  echo "Waiting for $NEW_COLOR health check ($i/30)..."
  sleep 2
done

echo "Health check failed for $NEW_COLOR after 60 seconds — rolling back"
docker compose -f docker-compose.yml -f "docker-compose.$NEW_COLOR.yml" down
exit 1
