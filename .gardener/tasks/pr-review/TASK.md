---
schema: gardener.task/v1
id: pr-review
name: Pull request review
description: Leaves one comment-only review when a pull request is opened.
trigger:
  event: github.pull_request.opened
  authors: maintainers
tools:
  - repository.list_files
  - repository.read_file
  - provider.api.read
effects:
  - pull_request.review.submit
network:
  default: deny
  allow: []
  deny: []
limits:
  runtime-seconds: 480
  max-turns: 16
  max-tool-calls: 24
  input-tokens: 128000
  output-tokens: 16000
---
Use the provider API to read the pull request's changed files
(`GET /repos/{owner}/{repo}/pulls/{number}/files`), then read related code if you need context.

Submit one review with event `comment`: a two-sentence summary of the change, then at most three
concrete observations (bugs, missing tests, or unclear code), each naming the file. Do not approve or
request changes, and skip style nits. Then finish.
