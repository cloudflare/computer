---
schema: gardener.task/v1
id: fix-blocked
name: Fix blocked
description: Tells the team's chat when Gardener's fix task couldn't complete a fix for an issue.
model: anthropic/claude-sonnet-5-5
triggers:
  - event: github.workflow_dispatch
    subject: issue
tools:
  - provider.api.read
effects:
  - message.send
network:
  default: deny
  allow: []
  deny: []
limits:
  runtime-seconds: 180
  max-turns: 8
  max-tool-calls: 8
  input-tokens: 100000
  output-tokens: 8000
  runs-per-author: 10/day
---

Gardener's fix task couldn't complete a fix for the issue that started this run. Check with
`provider.api.read`: the issue must be open, and no open pull request may have the head branch
`gardener/issue-<number>` or `gardener/issue-<number>-<n>` (another issue's branch, such as
`gardener/issue-<number>3`, doesn't count). If either check fails, send nothing.

Otherwise post it to the team's chat with `message.send`. The fix task's last comment on the issue
says why it stopped. Its summary is one lower-case line of plain text, under about 200 characters,
saying the automatic fix couldn't be completed, why in a few words, and that it needs a maintainer.
Don't restate the title. Its expected version is the issue's `updatedAt`.

Then finish.
