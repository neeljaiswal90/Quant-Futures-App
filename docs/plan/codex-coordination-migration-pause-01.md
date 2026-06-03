# Codex coordination — pause for fresh-repo migration

**To:** Codex / secondary engineer working on `feat/bookmap-trade-dots-01`
**From:** Coordinator
**Date:** 2026-06-03
**Action required:** commit + push current state, then pause until further notice.

## What's happening

We're migrating the codebase to a fresh repository at `D:\mnq-orderflow\`. The new repo will be created via `git filter-repo` from the current `D:\Quant-futures-app\` to preserve dashboard-side commit history while dropping algo-side paths.

**Your work on `feat/bookmap-trade-dots-01` will survive the migration** — `git filter-repo` preserves all branches + commits for the paths that are kept (which includes everything you're touching: `apps/dashboard_ui/src/chart/gpu/`, `apps/dashboard_ui/src/chart/tradeBubbles.ts`, `apps/dashboard_ui/src/vite-env.d.ts`).

The risk is: **uncommitted changes in your working directory will NOT be migrated.** `git filter-repo` operates on committed history only.

## What you need to do

1. **Stage + commit any in-progress work** on `feat/bookmap-trade-dots-01`.
   - Even WIP / partial commits are fine — better to land them than lose them
   - Suggested commit message prefix: `wip: ` for clearly unfinished work
2. **Push the branch** to GitHub:
   ```
   git push origin feat/bookmap-trade-dots-01
   ```
3. **Reply with the SHA** of your latest commit on the branch so I can verify it lands in the new repo post-filter-repo.
4. **Pause work** on the old repo. Do NOT keep editing `D:\Quant-futures-app\` files after pushing — any changes after this point will not migrate cleanly.

## What happens next

5. I run `git filter-repo` on a clone, producing `D:\mnq-orderflow\` with dashboard paths only + your branch + your commits intact.
6. I push the new repo to a fresh GitHub remote at `mnq-orderflow`.
7. I notify you of the new clone URL.
8. **You re-clone the new repo** and resume work on `feat/bookmap-trade-dots-01` there. Your tip commit SHA should match what you pushed.
9. `D:\Quant-futures-app\` becomes a read-only archive — do not commit there going forward.

## Estimated downtime for your work

- Pause requested: now
- Migration execution: ~2-3 hours from now
- Notification + resume signal: when migration verifies green

If you have not committed anything beyond what's already on GitHub, your downtime is just the pause window. Resume will be straightforward.

## What if you have uncommitted work that you don't want to commit yet (research / experiments)

Two options:
- **`git stash`** — your uncommitted changes survive in your local stash. Apply after re-cloning to a fresh worktree. (Stashes are local-only; they don't push to remote. Make sure your machine has them backed up.)
- **`git format-patch` to a file** — write your in-progress diff to a `.patch` file outside the repo, apply it later via `git apply` in the new clone. Resilient against ANY repo state change.

## Why we're doing this

The current `D:\Quant-futures-app\` repo has 7.1 GB `.git` directory, ~200 branches, and 72 worktree dirs at `D:\Quant-futures-app-*` — most of which are algo-side feature branches unrelated to the dashboard work you're doing. The new repo will be:
- ~1-2 GB `.git` (much faster `git status`, `git log`, `git clone`)
- Dashboard-only paths
- Clean branch list
- Single concern (no algo / strategy / scalp-model code competing for attention)

This is the right time to do it — before P9 trade-dots work ships, so your branch lands cleanly in the new repo on first commit.

## Acknowledgment

When you've committed + pushed + are paused, please respond with:
- The SHA of your tip commit on `feat/bookmap-trade-dots-01`
- Confirmation that you've stopped editing the old repo
- Any concerns about uncommitted state you want preserved

The coordinator will then begin filter-repo execution.
