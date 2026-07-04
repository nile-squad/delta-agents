import type { ReactNode } from "react";

const KEYWORDS = new Set([
  "import",
  "export",
  "const",
  "let",
  "var",
  "function",
  "async",
  "await",
  "return",
  "if",
  "else",
  "for",
  "while",
  "class",
  "extends",
  "new",
  "try",
  "catch",
  "throw",
  "typeof",
  "instanceof",
  "from",
  "as",
  "type",
  "interface",
  "default",
  "true",
  "false",
  "null",
  "undefined",
]);

const BUILTINS = new Set([
  "console",
  "Promise",
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Map",
  "Set",
  "Error",
  "Result",
  "Ok",
  "Err",
  "React",
  "useState",
  "useEffect",
  "useRef",
  "process",
  "require",
  "module",
  "exports",
]);

type Token = {
  type: "plain" | "keyword" | "builtin" | "string" | "comment" | "number";
  value: string;
};

function tokenize(code: string): Token[] {
  const result: Token[] = [];
  let i = 0;

  while (i < code.length) {
    if (code[i] === "\n") {
      result.push({ type: "plain", value: "\n" });
      i++;
      continue;
    }

    if (/\s/.test(code[i])) {
      let j = i;
      while (j < code.length && /\s/.test(code[j])) j++;
      result.push({ type: "plain", value: code.slice(i, j) });
      i = j;
      continue;
    }

    if (code.slice(i, i + 2) === "//") {
      let j = i;
      while (j < code.length && code[j] !== "\n") j++;
      result.push({ type: "comment", value: code.slice(i, j) });
      i = j;
      continue;
    }

    if (code.slice(i, i + 2) === "/*") {
      const end = code.indexOf("*/", i + 2);
      const j = end === -1 ? code.length : end + 2;
      result.push({ type: "comment", value: code.slice(i, j) });
      i = j;
      continue;
    }

    if (code[i] === '"' || code[i] === "'" || code[i] === "`") {
      const quote = code[i];
      let j = i + 1;
      while (j < code.length && code[j] !== quote) {
        if (code[j] === "\\") j++;
        j++;
      }
      if (j < code.length) j++;
      result.push({ type: "string", value: code.slice(i, j) });
      i = j;
      continue;
    }

    if (/[0-9]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[0-9.xXa-fA-FeE_]/.test(code[j])) j++;
      result.push({ type: "number", value: code.slice(i, j) });
      i = j;
      continue;
    }

    if (/[a-zA-Z_$]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[a-zA-Z0-9_$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      if (KEYWORDS.has(word)) {
        result.push({ type: "keyword", value: word });
      } else if (j < code.length && code[j] === "(") {
        result.push({ type: "builtin", value: word });
      } else if (BUILTINS.has(word)) {
        result.push({ type: "builtin", value: word });
      } else {
        result.push({ type: "plain", value: word });
      }
      i = j;
      continue;
    }

    result.push({ type: "plain", value: code[i] });
    i++;
  }

  return result;
}

// Sourced from shiki's bundled themes: Tokyo Night (dark) + Catppuccin Latte (light)
const COLOR_MAP: Record<Token["type"], string> = {
  plain: "",
  keyword: "#bb9af7",
  builtin: "#7aa2f7",
  string: "#9ece6a",
  comment: "#565f89",
  number: "#ff9e64",
};

export function highlightCode(code: string): ReactNode {
  const tokens = tokenize(code);

  // Merge adjacent tokens of the same type for fewer DOM nodes
  const merged: Token[] = [];
  for (const token of tokens) {
    const last = merged[merged.length - 1];
    if (last && last.type === token.type) {
      last.value += token.value;
    } else {
      merged.push({ ...token });
    }
  }

  const elements: ReactNode[] = [];
  let key = 0;
  for (const token of merged) {
    const color = COLOR_MAP[token.type];
    if (token.value === "\n") {
      elements.push(<br key={key++} />);
      continue;
    }
    if (!color) {
      elements.push(<span key={key++}>{token.value}</span>);
    } else {
      elements.push(
        <span key={key++} style={{ color }}>
          {token.value}
        </span>,
      );
    }
  }
  return elements;
}
