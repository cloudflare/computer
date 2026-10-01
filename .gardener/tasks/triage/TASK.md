---
schema: gardener.task/v1
id: triage
name: Triage
description: Summarises new issues, points out likely duplicates, and applies existing labels.
model: anthropic/claude-sonnet-5-5
trigger:
  event: github.issue.opened
  authors: maintainers
tools:
  - repository.list_files
  - repository.read_file
  - provider.api.read
effects:
  - issue.comment.create
  - issue.label.add
network:
  default: deny
  allow: []
  deny: []
limits:
  runtime-seconds: 300
  max-turns: 12
  max-tool-calls: 16
  input-tokens: 80000
  output-tokens: 16000
---
Triage the issue that triggered this run.

1. Use the provider API to list the repository's labels (`GET /repos/{owner}/{repo}/labels`) and to
   search for similar open issues (`GET /search/issues` with `q=repo:{owner}/{repo} is:issue
   is:open` plus two or three key words from the title).
2. Read repository files only if the issue is about specific code.
3. Propose `issue.comment.create`: at most 80 words, summarising the problem and the likely area of
   the code. If any open issue looks like a duplicate, link it. Do not promise a fix.
4. Propose `issue.label.add` for at most two labels that already exist and clearly fit. Skip this
   step if none fit; never invent a label.

Then finish.
