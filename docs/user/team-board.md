# Team board

When an agent runs two or more subagents in the same repository at once, they share a team board. Each subagent says which files it is about to change, posts what the others need to know and asks its questions there. Two subagents stop fixing the same bug twice or editing the same file without knowing.

There is nothing to turn on. The board appears when a second subagent starts in the same repository and closes when the team is done. A chat that never runs subagents side by side has no board and pays no tokens for one.

## What gets posted

- **Claim**: a subagent names the file or function it is taking. A claim on something a sibling already holds is refused, and both are told who holds it.
- **Finding**: something a sibling needs for its own work, such as "the settings schema moved".
- **Question**: asked of one sibling or of the lead.
- **Decision**: a shared rule from the lead or from you, such as an error code or a name. Decisions are pinned, and every subagent reads them before anything else.
- **Done**: the work is finished, often with the commit to reuse.

SSHCode also watches what each subagent really changes. If two of them edit the same lines without claiming them, both get a short note, and the board marks the overlap.

## Reading and posting

While a board has posts, a **Team board** pill sits above the composer of the lead chat, with the number of posts and overlaps. On iPhone it is part of the working pill.

- **Posts** lists everything, newest first. Filter by **Claims**, **Questions** or **Overlaps**.
- **Files** lists every file two or more subagents claimed or changed, who touched which lines, and whether their work will conflict when merged.
- **Message the team** sends your note to every working subagent at once.

Subagent rows show what each one holds right now. After the team finishes, the chat's menu keeps **Team board** so you can read what happened; past teams are listed there too.

## What it costs

A subagent with siblings gets one extra tool and a sentence of instructions. In our test, three agents on overlapping bug hunts made 33 duplicate fixes and 6 conflicted merges without a board, and none of either with it, for about 4% more token cost.
