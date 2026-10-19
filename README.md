# PR Review Desk

A local web page where three little robot reviewers run a [Claude Code](https://claude.com/claude-code) agent on your pull requests. They review new PRs with inline comments on GitHub, then recheck when the author pushes commits or replies in a thread you've commented in. On a recheck they resolve fixed threads and approve, or request changes.

There's nothing to install from npm: it's one Node server and one HTML page.

## Requirements

- Node 18 or newer
- [GitHub CLI](https://cli.github.com) signed in: `gh auth login`
- [Claude Code](https://claude.com/claude-code) signed in: run `claude` once

## Setup

```bash
git clone https://github.com/<you>/pr-review-desk.git
cd pr-review-desk
./install.sh
```

`install.sh` copies two files into your `~/.claude` folder:

- `claude/agents/pr-reviewer.md`: the reviewer agent each robot runs.
- `claude/skills/team-pr-review/SKILL.md`: the review method it follows.

It won't overwrite files you already have with the same names.

## Start it

```bash
REPOS=owner/repo node server.mjs
```

Open http://127.0.0.1:4317. `REPOS` is a comma-separated list of the repos where every open PR you didn't write counts as yours to review. You can also change it later in the page header.

| Setting | Default | Meaning |
|---|---|---|
| `REPOS` | none | Team repos to watch, e.g. `myorg/app,myorg/api` |
| `PORT` | `4317` | Port for the page |
| `MAX_PARALLEL` | `3` | How many reviewers can work at once |
| `DEPS_FROM` | none | Path to a local checkout with dependencies installed. Reviewers copy its `node_modules` to run tests, instead of running `npm install` on PR code |

Press Ctrl+C to stop the server and any running reviews.

## What counts as yours

- **Team PRs:** every open PR you didn't write in the `REPOS` you set.
- **Formal requests:** any PR that requests your review or assigns you.
- **Your reviews:** any open PR you've already reviewed, so replies and new commits get followed up.
- **Issues:** issues assigned to you are listed with their linked PRs. They're read-only; nothing is posted on them.

## PR status

| Status | Meaning | What auto-watch does |
|---|---|---|
| Not reviewed | You haven't reviewed it yet | Starts a **review** |
| Ready to recheck | New commits, a reply in a thread you've commented in, or you were asked again | Starts a **recheck** |
| Changes requested | You requested changes and nothing is new | Waits |
| Waiting on author | Nothing new since your last review | Waits |
| Approved | You approved the current commit | Waits |

## What the agent decides

- **First review:** posts inline findings. It requests changes if anything is blocking, and otherwise leaves a comment. It never approves on a first review.
- **Recheck:** checks each fix against the code and replies in every thread that got a reply. It resolves the threads it started once they're fixed. Then it **approves** if nothing blocking is left, or **requests changes** if something is.

## Using the page

- Drag a PR card onto a robot, or use the **Review** / **Recheck** buttons. Click a robot to watch its live log.
- Turn on **Auto-watch** to check GitHub on a timer (every 10 minutes by default). It starts the right run by itself, at most once per new change, and skips draft PRs. It only runs while the server is running.
- Settings you change on the page are saved in `settings.json` (not committed).

## Model and cost

Reviewers use your Claude Code default model (`/model` in Claude Code). The amount shown next to a run, such as "≈$0.34 usage", is what Claude Code reports that run would cost at API prices.

- **Claude subscription (Pro/Max):** runs count toward your plan's usage limits.
- **API key:** runs are billed to your API account.

## Safety

- **Posts as you.** Reviewers post on GitHub under your account, including approvals and change requests on rechecks. Try a few manual runs before turning on Auto-watch.
- **Local only.** The server listens on 127.0.0.1 only and rejects requests to any other hostname.
- **Other websites can't start runs.** Starting or stopping a run needs a token that's created fresh each time the server starts and that only the page has.
- **Blocked steps fail visibly.** Runs use Claude Code's `--permission-mode auto`. If a step gets blocked, the run shows as failed with the reason.
- **Your data stays out of git.** Run logs go in `runs/` and scratch clones in `work/`. Both are git-ignored and safe to delete.
