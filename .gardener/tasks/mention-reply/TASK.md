---
schema: gardener.task/v1
id: mention-reply
name: Mention reply
description: Answers when someone mentions the bot, and rebases a pull request on request.
triggers:
  - event: github.issue_comment.created
    mentions: [self]
  - event: github.discussion_comment.created
    mentions: [self]
tools:
  - repository.list_files
  - repository.read_file
  - provider.api.read
effects:
  - issue.comment.create
  - pull_request.comment.create
  - discussion.comment.create
  - pull_request.update_branch
network:
  default: deny
  allow: []
  deny: []
limits:
  runtime-seconds: 480
  max-turns: 12
  max-tool-calls: 16
  input-tokens: 128000
  output-tokens: 16000
---
Someone mentioned you in a comment. Read their comment and reply once, on the same thread:
`issue.comment.create` for an issue, `pull_request.comment.create` for a pull request,
`discussion.comment.create` for a discussion.

- Start the reply with `@` followed by the comment author's login.
- Answer their request in at most 80 words. Read repository files first if it is about the code.
- If it needs a code change, say so; do not claim to have changed anything.
- Never write the handle you were mentioned by.
- If the comment is on a pull request and asks you to rebase or update it, read the pull request
  with the provider API, then propose your reply followed by `pull_request.update_branch` with
  `method` `rebase` (or `merge` if they ask to merge the base in), using its current head and base.

Then finish.
