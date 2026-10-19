---
name: team-pr-review
description: Review a teammate's pull request and draft review comments in the team's "Bug / What to do" format, anchored to file:line, saved as an .md file in ~/Downloads for the user to post themselves. Use this whenever the user asks you to review a PR, look at a PR, check a teammate's branch, or says they are the named review partner on someone else's pull request — including when they just paste a GitHub PR URL with little other context. Built around the Capstone2-deploy capstone project's review conventions, but the method applies to any repo using the same comment format.
---

# Team PR review

The user is a **named review partner** on someone else's PR, not the author. Their job is to
find real defects and hand back short, anchored comments they will post themselves. They are
being graded on the quality of this review, so a missed race condition costs them more than a
missed style nit.

Two failure modes matter equally here, and the second is the easy one to forget:

- **Flagging something that isn't a bug.** Wastes the author's time and damages the user's
  credibility as a reviewer.
- **Dismissing something that is.** Worse, because it ships. If you catch yourself writing
  "this is fine because X prevents it," go verify X actually prevents it. A real example from
  this workflow: a non-atomic status guard was waved away as "needs concurrent students, which
  `MAX_PODS=1` prevents" — but the dangerous interleaving was *instructor vs. student*, which
  needs one of each. The dismissal was wrong and nearly shipped.

## Workflow

### 1. Read the PR before reading the diff

```bash
gh pr view <N> --repo <owner/repo> --json number,title,state,author,headRefName,baseRefName,additions,deletions,changedFiles,isDraft,mergeable,body
```

The body usually tells you three things worth knowing up front:

- **Who the named review partner is and what area they own.** If the PR says "Review partner is
  X (authorization / audit fields / forbidden-role tests)", that is the user's assignment. Cover
  it explicitly and say so in the top-level comment — but don't stop there.
- **Self-declared risks.** Authors often list known limitations. Verify each one rather than
  accepting it: sometimes the stated risk is narrower than the real one.
- **Scope.** Findings outside the PR's scope still get raised, but as notes rather than blockers.

### 2. Get the diff and the PR head, not your working tree

Line numbers must come from the PR's head commit. Your local checkout is almost certainly on a
different branch.

```bash
gh pr diff <N> --repo <owner/repo>
SHA=$(gh pr view <N> --repo <owner/repo> --json headRefOid --jq .headRefOid)
git fetch origin refs/pull/<N>/head -q
git show FETCH_HEAD:path/to/file.py > /tmp/pr<N>_file.py
grep -n '<pattern>' /tmp/pr<N>_file.py
```

Anchoring to the wrong line makes a correct finding unactionable, so confirm each anchor by
printing the surrounding lines before you write the comment.

### 3. Verify every claim against the code

Never review from the diff alone. The diff shows what changed, not what it interacts with.

- Trace called functions into their definitions. A handler that writes an audit log is only as
  safe as that logger's error handling.
- Check identity and ownership comparisons end to end — does the value being compared come from
  the same source as the value that was stored?
- Read the tests that were added. They often reveal intent: behavior you were about to flag as a
  bug may have a test asserting it, which makes it a design decision to discuss, not a defect.

### 4. Look for the patterns that actually bite

These recur in backend PRs and are worth a deliberate pass:

- **Check-then-write races.** A `SELECT` that validates state, then an unconditional `UPDATE`.
  In Python's sqlite3 legacy transaction mode a `with conn:` block does *not* begin the
  transaction at the read — it begins at the write, so the guard is not atomic. Ask who else can
  write that row between the two statements, and remember the other writer may be a *different
  role* hitting a *different endpoint*.
- **Writes that report success without checking `rowcount`.** If the row vanished between the
  existence check and the update, the endpoint returns 200 and logs an event for something that
  never persisted.
- **Audit writes outside the transaction they describe.** If the state change commits and the
  log write then fails, you get a silent, unattributed change. This matters most where the row
  is overwritten in place and the log is the only history.
- **Falsy-versus-`None` guards.** `if x is None` lets `""`, `{}`, `0` and `False` through. If
  those values then overwrite stored data, an "at least one field required" check is bypassable.
- **Character counts described as byte limits.** `len(s) > 65536` on a multi-byte string is not
  a 64 KB cap.
- **Partial field resets.** Clearing one field of a related group (`score`) while leaving its
  companions (`graded_by`, `feedback`) leaves rows that read as a state they are not in.
- **Type divergence from the house convention.** A new model using `Optional[object]` when the
  sibling model next to it uses `Optional[Union[str, dict, list]]` loosens validation and
  degrades the generated API schema.

### 5. Search the repo for the pattern the author should have used

This is the single highest-value step, and it is what turns a complaint into an actionable fix.
Before proposing a solution, grep the same file and its neighbours for an existing correct
implementation of the same concern.

Finding "this file already does compare-and-swap correctly at line 388, with `rowcount == 0` →
409" is far more persuasive than "you should use compare-and-swap", and it costs one grep. It
also means the fix matches the codebase instead of introducing a second convention.

### 6. Write the comments

Each inline comment is anchored to `path/to/file.ext:LINE` and has exactly two parts:

```markdown
**Bug:** <what is wrong, the concrete conditions that trigger it, and the observable
consequence. Name the interleaving or the input that causes it — a scenario is more convincing
than a category.>

**What to do:** <the concrete fix, referencing the existing pattern in the repo where one
exists, plus the test that would pin it.>
```

Keep each comment to a few sentences. A reviewer's comment that runs a page gets skimmed.

Mark each finding **blocking** or **non-blocking** so the author can triage. Blocking means data
loss, silent corruption, a security hole, or a broken contract. Nearly everything else is
non-blocking. Findings outside the PR's scope are notes with a pointer to where they belong
(another ticket, the design doc) — raise them so they're tracked, but don't hold the PR for them.

### 7. Say what you checked and cleared

A "Checked and cleared" section is not padding. It tells the author which of their worries you
actually examined, stops the same question being re-asked in the next review, and demonstrates
the review had a method. Include things you nearly flagged and why you didn't — especially
behavior that a test turned out to assert deliberately.

## Output

Save to **`~/Downloads/PR-<N>-review.md`** — not the repo, which keeps review notes out of the
working tree entirely. The user posts the comments themselves: never post, comment, approve, or
request changes on their behalf.

Structure:

```markdown
# PR #<N> review — <title>

Branch: `<head>` → `<base>`
Head: `<sha>`
Reviewer: <user> (named partner — <their assigned area>)

---

## Top-level review comment

<Lead with what is sound, specifically — reviewers who only list faults get discounted. Then
state what the findings are actually about, so the author knows where to look.>

---

## Inline comments

### 1. `path/file.ext:LINE` — blocking

**Bug:** ...

**What to do:** ...

### 2. `path/file.ext:LINE` — non-blocking

...

---

## Checked and cleared

- **<thing>** — <why it is fine>

## Reviewer checklist

<Copy the checklist from the PR body and tick honestly. Leave a box unticked and point at the
finding number that explains why — an all-ticked checklist alongside blocking findings reads as
rubber-stamping.>
```

## Working with a parallel automated review

If a `/code-review` run or similar is going in the background, draft your own findings while it
works rather than idling — independent analysis catches things a single pass misses, in both
directions.

When it returns, merge rather than concatenate: deduplicate overlapping findings, keep the
sharper articulation of each, and re-verify anything that contradicts your own conclusion before
accepting or rejecting it. If the automated pass corrected you, say so plainly in your summary
to the user and fix the file — it is better for the user to learn that from you than from their
teammate after posting.
