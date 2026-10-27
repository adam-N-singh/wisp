// Message markdown: GitHub-flavored, with highlighted code blocks, links that open in the browser
// through main, math ($$…$$ and ```math; no single-dollar math) and Mermaid
// diagrams (```mermaid). Math and diagrams load their engines on first use (RichContent.tsx).
import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { main } from "../bridge";
import { CodeBlock } from "./CodeBlock";
import { MathView, MermaidDiagram } from "./RichContent";

const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];

/** `streaming`: the text is still being written, so diagrams wait for it to finish. */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href != null && /^(https?:|mailto:)/i.test(href)) void main.openInBrowser({ url: href });
              }}
            >
              {children}
            </a>
          ),
          code: ({ className, children }) => {
            const text = String(children ?? "");
            const match = /language-([\w+-]+)/.exec(className ?? "");
            // remark-math marks $$…$$ as language-math, with math-inline when it sits in a line of text.
            if (match?.[1] === "math") return <MathView tex={text.replace(/\n$/, "")} display={!(className ?? "").includes("math-inline")} />;
            if (match?.[1] === "mermaid") return <MermaidDiagram code={text.replace(/\n$/, "")} streaming={streaming} />;
            if (match == null && !text.includes("\n")) return <code className="inline-code">{children as ReactNode}</code>;
            return <CodeBlock language={match?.[1] ?? ""} code={text.replace(/\n$/, "")} />;
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="markdown__table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
