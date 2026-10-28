---
schema: gardener.task/v1
id: fix-ready
name: Fix ready
description: Tells the team's chat when Gardener's fix task has opened a pull request.
model: anthropic/claude-sonnet-5-5
triggers:
  - event: github.workflow_dispatch
    subject: pull_request
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

Gardener's fix task opened the pull request that started this run. Check it with
`provider.api.read`: it must be open and its head branch must start with `gardener/issue-`. If it
isn't, send nothing.

Otherwise post it to the team's chat with `message.send`. Its summary is one lower-case line of
plain text, under about 200 characters, saying what it fixes and that it's ready for review. Don't
restate the title. Its expected version is the pull request's `updatedAt`.

Then finish.
