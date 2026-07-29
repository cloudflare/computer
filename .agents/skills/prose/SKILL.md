---
name: prose
description: |
  Style guidance for the written word. Use when asked to write code comments,
  commit messages, pull requests, READMEs, or documentation. Triggers might be
  phrases like "write a commit", "document this", or "add a README".
---

# Prose

1. IMPORTANT! Keep language simple. Use plain English.
2. IMPORTANT! Avoid technical terms or jargon when a plain word will do.
3. IMPORTANT! Avoid acronyms. Use the full word, e.g. "durable object"
   instead of "DO". Exceptions: established acronyms more common than
   their expansion, like "AI" or "API".
4. IMPORTANT! Never insert marker comments in code or decorative
   characters in prose.
5. IMPORTANT! Use American English at all times.
6. IMPORTANT! Never refer to conversations, chat history, review
   threads, agents, or development sessions when writing plans,
   documentation, commits, or pull requests. Stand-alone artifacts
   only.

## Voice

- **Talk like a human.** Avoid corporate or startup speak. Write like
  an engineer talking to another engineer.
- **Don't assume specialist knowledge.** Engineers are sophisticated,
  but don't assume domain context they may not share.
- **Be honest.** Don't hide reality. If you're doing something for a
  reason, say so.
- **Be clear.** Do the hard work to help readers understand complex
  ideas.
- **Be funny when it fits.** Not exclusionary "you had to be there"
  humor — Simpsons humor, where the joke doesn't get in the way for
  readers who don't catch it.
- **Use active voice.** "We will listen to your complaint", not "Your
  complaint will be listened to". Passive voice is fine when it reads
  more naturally, e.g. "Starting today, the per-second price is cut
  in half."
- **Talk directly to "you", the reader.**
- **Don't overuse exclamation points.** They lose their force when
  every other line ends in one.

## Word choice

- **Prefer simple verbs.**
  - "improve" not "revolutionize"
  - "use" not "leverage" or "utilize"
  - "help" not "assist"
  - "let" not "enable"
  - "make sure" not "ensure"
  - "turn off" or "shut down" not "sunset"
- **Prefer verbs to nouns.** "We help users", not "We provide help to
  users".
- **Drop adverbs that don't add information.** "thousands of models",
  not "thousands of incredible models".
- **Avoid words like "easy", "simply", "just".** They imply the reader
  is slow when they get stuck.
- **Avoid ableist and exclusionary terms** like "crazy" or "lame".

## Formatting

- **Sentence case** for headings, not Title Case.
- **Keep heading hierarchies flat.** One level deep is usually enough.
- **Use `code` formatting** for filenames, commands, classes, function
  names, and identifiers. e.g. "the `.gitignore` file", "call
  `req.fetch()`", "look at `MyClass`".
- **Use code blocks** for commands the reader is supposed to run, and
  for examples longer than a line.
- **ISO 8601 dates** (`2024-10-24`) or human-readable
  ("October 24, 2024"). Never `10/24/2024`.
- **American English spelling** (color, behavior, organize, defense).
- **Don't overuse bold.** If you need bold to give a block of text
  structure, the text probably needs to be restructured.
- **Spell out email addresses** instead of hiding them behind
  `mailto:` links.

## Markdown

- Use GitHub-flavored markdown unless instructed otherwise.
- Use code braces for variable names, classes, identifiers.
- Do not use hard line breaks inside paragraphs.

---

# Commit messages

Commit messages are read out of context, years later, by people who
have no memory of the change. Write them for that reader.

The canonical reference is Tim Pope's note on git commit messages
(<https://tbaggery.com/2008/04/19/a-note-about-git-commit-messages.html>).
The rules below are the project's interpretation of it.

## Structure

A commit message has a **subject line**, a **blank line**, and an
optional **body**.

```
scope: short summary in the imperative

Optional body, wrapped at 72 characters, explaining what changed and
why. Multiple paragraphs are fine. Reference code identifiers like
`functionName` or `ClassName` in prose when needed.

Signed-off-by: Name <email@example.com>
```

## Rules

1. **Subject line.** Imperative mood. Capitalize the first letter of
   the summary part. No trailing period. Target ≤ 50 characters; 72
   is the hard maximum.

   The capitalization rule applies to the part **after** the scope
   prefix colon. Lowercase scope prefixes are preserved when they
   match the project convention: `computerd:`, `rpc:`, `examples/think:`,
   `computerd, rpc:`, `docs:`.

2. **Blank line** between subject and body. The body is wrapped at
   72 characters per line.

3. **The body explains what and why**, not how. The diff already
   shows how. Reference code identifiers (class, function, file
   names) in prose when needed for context.

4. **No conversational phrases.** Strike phrases that only make
   sense in a development conversation:

   - "we hit in testing"
   - "handy for"
   - "worth noting"
   - "as discussed"
   - "per review"
   - "review feedback"
   - "the next time someone is tempted"
   - "quite reasonably"
   - "let's"
   - "feel free to"
   - "for what it's worth"
   - "in passing"

   Strike first-person plural ("we", "us", "our") when it refers to a
   development conversation rather than to a code identifier or to the
   reader. "We add a check" → "Add a check". "We use Foo in the
   gateway" stays as "Use Foo in the gateway".

5. **No external references.** Strike or rephrase:

   - Other commit SHAs ("for bc9827b", "after 745a0ef"). If the prior
     change must be named, describe it by name in prose.
   - Plan files, design docs, review threads, chat history, agents,
     testing sessions, task identifiers like `Y4` / `R7` / `B3` / `F1`.
   - GitHub issues or pull requests from other repositories cited as
     anecdotes.
   - A `(#N)` trailer that names the pull request that introduced the
     commit is allowed — that's git-native metadata, not a
     conversation reference.

   A commit that itself edits a plan file or a doc may still reference
   that file; the rule is about *external* anchors.

6. **Empty bodies are fine** when the subject is self-explanatory.
   Do not pad. Add a body only when the subject does not answer the
   "why" or the diff's intent is non-obvious.

7. **No headings, no bulleted lists** in commit bodies. Prefer prose
   paragraphs. Inline `code` formatting is fine. If a list feels
   unavoidable, recast it as a sentence: "The change covers reads,
   writes, and deletes" instead of three bullets.

8. **State facts, not arguments.** Describe what the code does and
   what changes. Avoid comparative claims like "X adds nothing", "Y is
   redundant", "this is better than Z", unless the comparison *is*
   the change. If a rationale is needed, state the observable behavior
   that motivated it and let the reader draw the conclusion.

   Bad: "Per-turn recovery adds nothing on top of the workflow's own
   retry."

   Good: "With recovery enabled, an upstream call that wedges a turn
   in a non-terminal state produces a tight loop logging
   `_chatRecoveryContinue timed out waiting for stable state`. The
   workflow's own retry is the correct replay boundary."

9. **Self-contained.** A reader on the main branch five years from
   now should understand the commit from its message alone, without
   chasing tickets, chat logs, or sibling commits.

10. **American English** spelling and grammar in prose. Code
    identifiers keep their original spelling — if the symbol is
    named `materialiseChange`, refer to it as `materialiseChange`.

11. **Preserve trailers** at the end of the body verbatim:
    `Signed-off-by:`, `Co-authored-by:`, `Reviewed-by:`, `Fixes:`.

## Examples

### Before

```
examples/think: turn off chatRecovery on TriageAgent

The agent runs inside a Workflow, which is already the durable
replay layer for this design: step.do and step.prompt rerun
deterministically across DO eviction ...

Layering Think's per-turn chat recovery on top of that adds nothing
useful here — there is no human watching transient chat state ...
What it does add is a noisy recovery loop: when an upstream call
wedges a turn in a non-terminal state (the Workers AI 502s and Kimi
context overflows we hit in testing), Think keeps logging
"_chatRecoveryContinue timed out waiting for stable state" ...

Flip the field to false and document why so the choice survives
the next time someone is tempted to turn it back on for an
unrelated reason.
```

Violations: rule 3 (acronym `DO`), rule 4 (`we hit in testing`,
`the next time someone is tempted`), rule 8 (`adds nothing useful`).

### After

```
examples/think: disable chatRecovery on TriageAgent

The agent runs inside a Workflow, which is the durable replay layer
for this design. step.do and step.prompt rerun deterministically
across eviction, and runAgentTurn keys its submitMessages call so a
replayed explore step rejoins the existing submission rather than
starting a new one.

With recovery enabled, an upstream call that wedges a turn in a
non-terminal state (Workers AI 502s, context overflows on long
prompts) produces a tight loop logging "_chatRecoveryContinue
timed out waiting for stable state". The workflow's own retry is
the correct replay boundary.

Set the field to false and document the reasoning inline.
```

### Before

```
computerd, rpc: tests for the FUSE_SHIM flush hook

Two complementary test pairs for bc9827b. The computerd side proves the
shim materialises on demand without relying on its 250ms poll ...

shim.test.ts:
  - flush() materialises pending VFS writes onto disk ...
  - flush() is idempotent ...
  - flush() is safe to call on an unmounted shim — handy for
    teardown paths ...
```

Violations: rule 5 (SHA reference `bc9827b`), rule 7 (bulleted lists,
file-name headings), rule 4 (`handy for`), rule 10 (`materialises`).

### After

```
computerd, rpc: test the FUSE shim flush hook

Cover the flush hook from both ends. The computerd side proves the shim
materializes on demand without relying on its 250ms poll; the rpc
side proves SyncRPC fires afterApply exactly when it should and
tolerates a hook that throws.

On the computerd side, flush() materializes pending VFS writes onto disk
before resolving, is idempotent against an unchanged tree, and is
safe to call on an unmounted shim.

On the rpc side, afterApply fires once per push and observes the
committed state. Empty pushes skip the hook. A throwing hook is
logged and swallowed: pushOnce still returns the entry count and
the entries remain durable on the receiver.
```

---

For pull request bodies, see the separate
[`pull-requests`](../pull-requests/SKILL.md) skill. The voice and
word-choice rules above apply there too.
