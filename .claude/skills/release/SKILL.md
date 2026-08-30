---
name: release
description: Cut a release of term-spotify. Works out what has changed since the last tag from the commits, proposes one changelog line per change a listener would notice, waits for the user to confirm each one is actually proved to work, then runs `pnpm release` to bump, tag, push and publish the GitHub release. Use ONLY when the user says "release", "cut a release", "ship a release", or invokes /release. Accepts an optional patch|minor|major argument; major is honoured only when explicitly given.
---

# Cutting a release

The user typing `/release` **is** the judgment call that it is time. Do not suggest a release unprompted, and do not run this because entries have accumulated.

Two things make this skill different from a changelog generator, and both matter more than the mechanics:

* **A commit is not proof.** CI here typechecks and builds; it cannot tell whether the console looks right with music playing. Only the user can. So a change goes in the changelog because they confirmed it works, not because it is in the range.
* **You never decide to override a guard.** If `pnpm release` refuses, bring the refusal back to the user. Never pass `--yes` on your own reasoning.

## 1. Establish the range

```zsh
/opt/homebrew/bin/git describe --tags --abbrev=0                    # last tag, e.g. v0.1.0
/opt/homebrew/bin/git log <tag>..HEAD --format='%h%x09%s'
/opt/homebrew/bin/git log origin/main..HEAD --oneline               # must be empty
```

Stop if the range is empty: there is nothing to release. Stop if anything is unpushed, because CI has not seen it and the user cannot have judged it.

Read the full message of anything whose subject is not self explanatory (`git show -s --format=%B <sha>`), and the files it touched (`git show --stat <sha>`). The commit messages in this repo carry the reasoning, so they are the source. That is the whole reason they are written the way they are.

## 2. Pre-flight before writing anything

```zsh
/opt/homebrew/bin/git status --porcelain          # must be empty
/opt/homebrew/bin/git rev-parse --abbrev-ref HEAD # must be main
pnpm typecheck
```

Then CI for the range:

```zsh
export GH_TOKEN=$(op item get "PAT: DMXL" --fields token --reveal)
gh run list --repo DMXL/term-spotify --limit 15 --json headSha,conclusion,displayTitle \
  --jq '.[] | "\(.headSha[0:7])  \(.conclusion)  \(.displayTitle)"'
```

Doing this first means a failure that was going to happen anyway does not waste the user's time in the review below.

## 3. Classify each commit

For each commit, decide whether a person running the console could tell it happened.

| Gets a line | Gets no line |
|---|---|
| Behaviour they can see or drive | Refactors nothing outside the repo can see |
| A new or changed key, subcommand, or default | Prose: README, CLAUDE.md, comments |
| Something removed | Build, CI, tooling, the release machinery itself |
| A fix to something visibly wrong | Anything that leaves the console behaving identically |

Categories are `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security`.

Draft each line at **one line**, under 180 characters, stating what a user would notice. The reasoning stays in the commit. If a line needs a second sentence, the first was the wrong one.

## 4. Show the table and wait

Present every commit in the range, including the ones getting no line, so the user can see nothing was quietly dropped:

```
Since v0.1.0, 3 commits, CI green on all.

  2da2014  Fill the cover box instead of fitting inside it     CI ok
           → Fixed: The cover fills its box instead of leaving a band of background beneath it.

  3834ca8  Keep the changelog to one line a change             CI ok
           → no line (process and tooling)

  b98491e  Name the package manager                            CI ok
           → no line (CI config)

Confirm each proposed line is a change you have seen working. Reword or strike any of them.
```

**Then stop and wait.** This is the point of the skill. Do not write the notes file, and do not run anything, until the user has answered.

Flag anything with a CI result that is not `success`.

If the user cannot confirm a user facing change, say so plainly and offer the choice: leave it unlogged and release anyway, or hold the release until they have checked it. Recommend holding, since an unconfirmed change is not one worth announcing.

## 5. Decide the bump

| Confirmed lines contain | Bump |
|---|---|
| `Fixed` only | `patch` |
| Any `Added`, `Changed`, `Removed` or `Deprecated` | `minor` |
| Nothing, because everything was struck | No release. Say so and stop |

Small does not make a feature a patch. Whether a user could notice is the axis, not size.

`major` **only** when the user explicitly typed it (`/release major`). Never infer it. On a `0.x` version it means `1.0.0`, which claims the bug hunt is over and this surface is one worth keeping, so confirm they mean that before running anything.

If the user passed a kind that disagrees with the table, say which one the entries imply and why, and let them choose.

## 6. Write the notes and run

Write the confirmed lines to a file in the scratchpad directory, categories as `### ` headings, one bullet per line, nothing else:

```markdown
### Fixed

* The cover fills its box instead of leaving a band of background beneath it.
```

Then:

```zsh
pnpm release <kind> --notes-file <path> --dry-run   # optional, if anything is uncertain
pnpm release <kind> --notes-file <path>
```

`pnpm release` re-checks all of this independently and then writes the dated section into `CHANGELOG.md`, bumps `package.json`, commits as `Release vX.Y.Z`, tags, pushes commit and tag together, and creates the GitHub release with those notes. One commit, one push.

The 1Password prompt may appear at that point, which is the user's to approve.

Report the release URL when it finishes.

## If it refuses

Every guard is telling you something true. Read it, fix the cause, and run again. If the fix is a judgment call, such as the bump disagreeing with the entries, take it back to the user. Do not reach for `--yes`.
