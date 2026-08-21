import type { ReactElement, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { SqlBlock } from "./sql-block";

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el?.props) return textOf(el.props.children);
  return "";
}

/** Assistant markdown, styled to match the prototype paragraphs (inline code = mono pill). */
export function Markdown({ children, onOpenSql }: { children: string; onOpenSql?: (sql: string) => void }) {
  const components: Components = {
    p: ({ children: c }) => <p className="text-sm leading-relaxed">{c}</p>,
    strong: ({ children: c }) => <b className="font-semibold">{c}</b>,
    em: ({ children: c }) => <i>{c}</i>,
    a: ({ children: c, href }) => (
      <a href={href} target="_blank" rel="noreferrer" className="text-brand-ink underline underline-offset-2">
        {c}
      </a>
    ),
    ul: ({ children: c }) => <ul className="ml-4 list-disc space-y-1 text-sm leading-relaxed">{c}</ul>,
    ol: ({ children: c }) => <ol className="ml-4 list-decimal space-y-1 text-sm leading-relaxed">{c}</ol>,
    li: ({ children: c }) => <li className="pl-0.5">{c}</li>,
    h1: ({ children: c }) => <h3 className="text-sm font-semibold tracking-tight">{c}</h3>,
    h2: ({ children: c }) => <h3 className="text-sm font-semibold tracking-tight">{c}</h3>,
    h3: ({ children: c }) => <h4 className="text-[13px] font-semibold tracking-tight">{c}</h4>,
    blockquote: ({ children: c }) => (
      <blockquote className="border-l-2 border-line-strong pl-3 text-sm text-ink-2">{c}</blockquote>
    ),
    hr: () => <hr className="border-line" />,
    code: ({ children: c }) => (
      <span className="rounded-sm bg-inset px-1 py-0.5 font-mono text-[12px] text-ink">{c}</span>
    ),
    pre: ({ children: c }) => {
      const child = c as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
      const lang = /language-(\w+)/.exec(child?.props?.className ?? "")?.[1] ?? "";
      const code = textOf(child?.props?.children).replace(/\n$/, "");
      if (lang === "sql" || (!lang && /^\s*(select|with|insert|update|delete|create|explain)\b/i.test(code))) {
        return <SqlBlock code={code} onOpen={onOpenSql} />;
      }
      return (
        <pre className="overflow-x-auto rounded-md bg-surface px-3 py-2.5 font-mono text-xs leading-relaxed text-ink shadow-hairline">
          {code}
        </pre>
      );
    },
    table: ({ children: c }) => (
      <div className="overflow-hidden rounded-md bg-surface shadow-hairline">
        <Table className="w-max min-w-full text-[13px]">{c}</Table>
      </div>
    ),
    thead: ({ children: c }) => <TableHeader className="bg-inset [&_tr]:border-line-strong">{c}</TableHeader>,
    tbody: ({ children: c }) => <TableBody className="[&_tr:nth-child(even)]:bg-inset/50">{c}</TableBody>,
    tr: ({ children: c }) => <TableRow className="hover:bg-hover">{c}</TableRow>,
    th: ({ children: c }) => (
      <TableHead className="h-9 border-r border-line-strong px-3 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-2 last:border-r-0">
        {c}
      </TableHead>
    ),
    td: ({ children: c }) => (
      <TableCell className="max-w-80 min-w-28 whitespace-normal border-r border-line px-3 py-2 align-top leading-relaxed last:border-r-0">
        {c}
      </TableCell>
    ),
  };

  return (
    <div className="flex flex-col gap-2.5">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
