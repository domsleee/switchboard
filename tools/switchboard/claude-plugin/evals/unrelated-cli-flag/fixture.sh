#!/usr/bin/env bash
set -euo pipefail
cat > cli.py <<'EOF'
import argparse


def main():
    parser = argparse.ArgumentParser(description="Count lines in files.")
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()
    total = 0
    for name in args.files:
        with open(name) as f:
            total += sum(1 for _ in f)
    print(total)


if __name__ == "__main__":
    main()
EOF
