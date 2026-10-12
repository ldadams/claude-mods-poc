#!/bin/sh
# One-time setup: checks Node and Claude Code, installs Workbench Web's packages.
# ./setup.sh --laya also downloads Laya's weights (about 1.6 GB, once, to ~/.cache/receptron-laya)
# and switches decisions on in shadow mode.
set -eu
cd "$(dirname "$0")"

node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null ||
  { echo "Needs Node 20 or later (https://nodejs.org)."; exit 1; }
command -v claude >/dev/null ||
  { echo "Needs Claude Code: https://claude.com/claude-code, then run 'claude' once to log in."; exit 1; }

(cd workbench-web && npm install --no-fund --no-audit)

if [ "${1:-}" = "--laya" ]; then
  echo "Downloading Laya (about 1.6 GB, once)..."
  (cd workbench-web && node -e 'import("@receptron/laya").then(({ Laya }) => Laya.load()).then(() => console.log("Laya is ready."))')
  node -e '
    const fs = require("fs"), f = ".claude/workbench.json"
    const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}
    c.decisions = { ...c.decisions, provider: "laya", mode: c.decisions?.mode || "shadow" }
    fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n")
    console.log("Decisions on in " + c.decisions.mode + " mode (" + f + ").")'
fi

cat <<'NEXT'

Ready. In two terminals, from this folder:

  node workbench-web/server.mjs .     Workbench Web: http://localhost:4477, docs at /docs/
  claude --plugin-dir ./workbench     Claude Code with the mod, then type /workbench
NEXT
