// Changelog entry formatter.
//
// Wraps `@changesets/changelog-github`, which resolves a changeset to its
// pull request, commit, and author, and reorders the parts it produces.
// The upstream line leads with the links and pushes the description to the
// end:
//
//   - #108 3074d90 Thanks @user! - The /connect caller now provides ...
//
// This one leads with the description, so a reader scanning the changelog
// sees what changed before where it came from:
//
//   - #108 The /connect caller now provides ... (3074d90) - Thanks @user
//
// Dependency lines are left to the upstream implementation, which already
// reads well and carries no description of its own.

import githubChangelog from "@changesets/changelog-github";

const upstream = githubChangelog.default ?? githubChangelog;

// The upstream release line, whose exact shape is:
//
//   "\n\n-" + prefix + (prefix ? " -" : "") + " " + firstLine + "\n" + rest
//
// where prefix is the concatenation of the pull request link, the commit
// link, and "Thanks <users>!", each already prefixed with a space and any
// of them possibly absent.
const RELEASE_LINE = /^\n\n- (?<prefix>.*?) - (?<body>[\s\S]*)$/;

export function reorderReleaseLine(line) {
  const match = RELEASE_LINE.exec(line);
  // No prefix means no pull request, commit, or author was resolved, so
  // there is nothing to reorder and the line already leads with its
  // description.
  if (match === null) return line;

  const { prefix, body } = match.groups;
  const parts = prefix.trim().split(" ");

  const pull = parts.find((p) => p.startsWith("[#")) ?? "";
  const commit = parts.find((p) => p.startsWith("[`")) ?? "";
  const thanksAt = parts.indexOf("Thanks");
  const users =
    thanksAt === -1
      ? ""
      : parts
          .slice(thanksAt + 1)
          .join(" ")
          .replace(/!$/, "");

  // The description keeps its own trailing lines; only the first line of
  // the body carries the trailing metadata.
  const [firstLine, ...rest] = body.split("\n");

  const tail = [commit === "" ? "" : `(${commit})`, users === "" ? "" : `Thanks ${users}`]
    .filter((p) => p !== "")
    .join(" - ");

  const head = [pull, firstLine].filter((p) => p !== "").join(" ");
  const reordered = tail === "" ? head : `${head} ${tail.startsWith("(") ? tail : `- ${tail}`}`;

  return ["\n\n- ", reordered, rest.length === 0 ? "" : `\n${rest.join("\n")}`].join("");
}

const changelogFunctions = {
  getDependencyReleaseLine: upstream.getDependencyReleaseLine,
  getReleaseLine: async (changeset, type, options) => {
    const line = await upstream.getReleaseLine(changeset, type, options);
    return reorderReleaseLine(line);
  },
};

export default changelogFunctions;
