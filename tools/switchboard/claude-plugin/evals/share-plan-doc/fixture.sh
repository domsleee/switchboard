#!/usr/bin/env bash
set -euo pipefail
mkdir -p docs/images
cat > docs/PLAN.md <<'EOF'
# Tab creation latency plan

New tabs take 400 ms to appear. Create the pane before the layout round trip.

![Current flow](images/flow.png)
EOF
echo 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' | base64 -d > docs/images/flow.png
printf '# Notes\n\nUnrelated.\n' > docs/NOTES.md
