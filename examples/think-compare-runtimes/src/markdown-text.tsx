import { type ComponentProps, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { HighlighterCore } from "shiki/core";

export function MarkdownText({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        a: Link,
        code: Code,
        h2: Heading2,
        h3: Heading3,
        li: ListItem,
        ol: OrderedList,
        p: Paragraph,
        pre: Pre,
        strong: Strong,
        table: Table,
        ul: UnorderedList,
      }}
      remarkPlugins={[remarkGfm]}
    >
      {text}
    </ReactMarkdown>
  );
}

function Heading2(props: ComponentProps<"h2"> & { node?: unknown }) {
  const { node: _node, ...rest } = props;
  return (
    <h2 className="mt-3 text-base font-semibold tracking-[-0.02em] text-[#E6E8EA]" {...rest} />
  );
}

function Heading3(props: ComponentProps<"h3"> & { node?: unknown }) {
  const { node: _node, ...rest } = props;
  return <h3 className="mt-2 text-sm font-semibold tracking-[-0.01em] text-[#E6E8EA]" {...rest} />;
}

function Paragraph(props: ComponentProps<"p"> & { node?: unknown }) {
  const { node: _node, ...rest } = props;
  return <p className="mt-2 text-sm leading-6 text-[#C9CDD2]" {...rest} />;
}

function OrderedList(props: ComponentProps<"ol"> & { node?: unknown }) {
  const { node: _node, ...rest } = props;
  return (
    <ol className="mt-2 ml-5 grid list-decimal gap-1 text-sm leading-6 text-[#C9CDD2]" {...rest} />
  );
}

function UnorderedList(props: ComponentProps<"ul"> & { node?: unknown }) {
  const { node: _node, ...rest } = props;
  return (
    <ul className="mt-2 ml-5 grid list-disc gap-1 text-sm leading-6 text-[#C9CDD2]" {...rest} />
  );
}

function ListItem(props: ComponentProps<"li"> & { node?: unknown }) {
  const { node: _node, ...rest } = props;
  return <li className="pl-1" {...rest} />;
}

function Strong(props: ComponentProps<"strong"> & { node?: unknown }) {
  const { node: _node, ...rest } = props;
  return <strong className="font-semibold text-[#E6E8EA]" {...rest} />;
}

function Link(props: ComponentProps<"a"> & { node?: unknown }) {
  const { node: _node, ...rest } = props;
  return (
    <a
      className="text-[#5BC8A7] underline decoration-[#5BC8A7]/40 underline-offset-4"
      rel="noreferrer"
      target="_blank"
      {...rest}
    />
  );
}

function Table(props: ComponentProps<"table"> & { node?: unknown }) {
  const { node: _node, ...rest } = props;
  return (
    <div className="mt-3 overflow-x-auto rounded-sm border border-[#22272E]">
      <table className="min-w-full border-collapse text-left text-sm text-[#C9CDD2]" {...rest} />
    </div>
  );
}

function Pre({ children }: ComponentProps<"pre"> & { node?: unknown }) {
  return <>{children}</>;
}

function Code({
  children,
  className,
  node: _node,
  ...props
}: ComponentProps<"code"> & { node?: unknown }) {
  const source = String(children ?? "");
  const language = /language-([\w-]+)/.exec(className ?? "")?.[1];

  if (language) {
    return <ShikiCodeBlock code={source.replace(/\n$/, "")} language={language} />;
  }

  return (
    <code className="rounded bg-[#22272E] px-1 py-0.5 font-mono text-[#E6E8EA]" {...props}>
      {children}
    </code>
  );
}

interface HighlightToken {
  content: string;
  offset: number;
  color?: string;
}

interface HighlightLine {
  key: string;
  tokens: HighlightToken[];
}

const supportedLanguages = new Set([
  "bash",
  "javascript",
  "json",
  "jsonc",
  "js",
  "jsx",
  "markdown",
  "md",
  "sh",
  "shell",
  "shellscript",
  "tsx",
  "ts",
  "typescript",
]);

let highlighter: Promise<HighlighterCore> | null = null;

function ShikiCodeBlock({ code, language }: { code: string; language: string }) {
  const [lines, setLines] = useState<HighlightLine[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    void getHighlighter()
      .then((shiki) =>
        shiki.codeToTokens(code, {
          lang: normalizeLanguage(language),
          theme: "github-dark-dimmed",
        }),
      )
      .then((highlighted) => {
        if (!cancelled) setLines(createHighlightLines(highlighted.tokens, code));
      })
      .catch(() => {
        if (!cancelled) setLines(null);
      });

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  return (
    <pre className="mt-3 overflow-x-auto rounded-sm border border-[#22272E] bg-[#171A1F] p-4 font-mono text-sm leading-6 text-[#C9CDD2]">
      <code>
        {lines
          ? lines.map((line) => (
              <span className="block" key={line.key}>
                {line.tokens.map((token) => (
                  <span
                    key={`${token.offset}-${token.content}`}
                    style={token.color ? { color: token.color } : undefined}
                  >
                    {token.content}
                  </span>
                ))}
              </span>
            ))
          : code}
      </code>
    </pre>
  );
}

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([
    import("shiki/core"),
    import("@shikijs/engine-javascript"),
    import("@shikijs/langs/typescript"),
    import("@shikijs/langs/javascript"),
    import("@shikijs/langs/tsx"),
    import("@shikijs/langs/shellscript"),
    import("@shikijs/langs/json"),
    import("@shikijs/langs/jsonc"),
    import("@shikijs/langs/markdown"),
    import("@shikijs/themes/github-dark-dimmed"),
  ]).then(
    ([core, engine, typescript, javascript, tsx, shellscript, json, jsonc, markdown, theme]) =>
      core.createHighlighterCore({
        themes: [theme.default],
        langs: [
          typescript.default,
          javascript.default,
          tsx.default,
          shellscript.default,
          json.default,
          jsonc.default,
          markdown.default,
        ],
        engine: engine.createJavaScriptRegexEngine(),
      }),
  );
  return highlighter;
}

function normalizeLanguage(language: string): string {
  const normalized = language.toLowerCase();
  if (normalized === "js") return "javascript";
  if (normalized === "ts") return "typescript";
  if (normalized === "sh" || normalized === "shell" || normalized === "bash") return "shellscript";
  if (normalized === "md") return "markdown";
  return supportedLanguages.has(normalized) ? normalized : "text";
}

function createHighlightLines(tokens: HighlightToken[][], code: string): HighlightLine[] {
  const sourceLines = code.split("\n");
  let runningOffset = 0;

  return tokens.map((line) => {
    const key = line[0] ? `line-${line[0].offset}` : `line-${runningOffset}`;
    const sourceLine = sourceLines.shift() ?? "";
    runningOffset += sourceLine.length + 1;
    return { key, tokens: line };
  });
}
