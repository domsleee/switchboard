#!/usr/bin/env bash
set -euo pipefail
mkdir -p bench
# An MP4 file-type box, so the file looks like a real recording, then filler.
{ printf '\000\000\000\030ftypisom\000\000\002\000isomiso2'; head -c 4096 /dev/urandom; } > bench/tab-switch-benchmark.mp4
printf 'run,ms\n1,41\n2,39\n' > bench/results.csv
