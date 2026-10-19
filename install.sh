#!/bin/sh
# Copies the reviewer agent and its review skill into ~/.claude.
# Existing files with the same name are kept; delete them first to replace them.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.claude/agents" "$HOME/.claude/skills/team-pr-review"
cp -n "$HERE/claude/agents/pr-reviewer.md" "$HOME/.claude/agents/pr-reviewer.md" || true
cp -n "$HERE/claude/skills/team-pr-review/SKILL.md" "$HOME/.claude/skills/team-pr-review/SKILL.md" || true
echo "Installed: ~/.claude/agents/pr-reviewer.md and ~/.claude/skills/team-pr-review/SKILL.md"
echo "Start the desk with:  REPOS=owner/repo node \"$HERE/server.mjs\""
