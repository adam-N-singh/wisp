// A highlighted code block with a Copy button, for message Markdown and diagrams shown as code.
import { useState } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Icon } from "./icons";

for (const [name, language] of Object.entries({ bash, css, diff, javascript, json, markdown, powershell, python, sql, typescript, xml, yaml })) hljs.registerLanguage(name, language);
hljs.registerAliases(["sh", "shell", "zsh", "console"], { languageName: "bash" });
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["ps1", "pwsh"], { languageName: "powershell" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["yml"], { languageName: "yaml" });

/** `plain` skips highlighting (a diagram's source isn't any of the registered languages). */
export function CodeBlock({ language, code, plain = false }: { language: string; code: string; plain?: boolean }) {
  const [copied, setCopied] = useState(false);
  const known = language.length > 0 && hljs.getLanguage(language) != null;
  const html = plain ? null : known ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span>{language || "text"}</span>
        <button
          type="button"
          className="icon-button icon-button--small"
          aria-label="Copy code"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          <Icon name={copied ? "check" : "file"} size={14} />
        </button>
      </div>
      <pre>{html != null ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code className="hljs">{code}</code>}</pre>
    </div>
  );
}
