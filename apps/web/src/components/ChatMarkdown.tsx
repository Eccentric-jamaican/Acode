import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";
import { CheckIcon, CopyIcon, FileIcon, FolderIcon } from "lucide-react";
import {
  Children,
  Suspense,
  isValidElement,
  use,
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import { normalizeSyntaxLanguage } from "../lib/syntaxLanguage";
import { useTheme } from "../hooks/useTheme";
import {
  normalizeMarkdownFileLinkLabel,
  parseMarkdownFileLinkLiteral,
  inferMarkdownPathKind,
  parseMarkdownGitHubLink,
  resolveMarkdownFileLinkTarget,
  resolveMarkdownFileViewerPath,
  type MarkdownPathKind,
} from "../markdown-links";
import { readNativeApi } from "../nativeApi";
import { preferredTerminalEditor } from "../terminal-links";
import { cn } from "../lib/utils";
import { getVscodeIconUrlForEntry } from "../vscode-icons";
import { GitHubIcon } from "./Icons";

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  variant?: "assistant" | "user";
  onOpenFilePath?: ((relativePath: string) => void) | undefined;
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 250;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 20 * 1024 * 1024;
const MAX_HIGHLIGHTED_CODE_CHARS = 40_000;
const EDITOR_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
type ResolvedHighlighter = {
  highlighter: DiffsHighlighter;
  language: string;
};
const highlighterPromiseCache = new Map<string, Promise<ResolvedHighlighter>>();

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  return match?.[1] ?? "text";
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    onlyChild.type !== "code"
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function fileIconPathValue(pathValue: string): string {
  return pathValue.replace(EDITOR_POSITION_SUFFIX_PATTERN, "").replaceAll("\\", "/");
}

function getHighlighterPromise(language: string): Promise<ResolvedHighlighter> {
  const normalizedLanguage = normalizeSyntaxLanguage(language);
  const cached = highlighterPromiseCache.get(normalizedLanguage);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [normalizedLanguage as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  })
    .then((highlighter) => ({ highlighter, language: normalizedLanguage }))
    .catch(async (error) => {
      console.warn(
        `[ChatMarkdown] Unable to load language "${normalizedLanguage}", falling back to "text".`,
        error,
      );
      const fallbackLanguage = "text";
      const fallbackHighlighter = await getSharedHighlighter({
        themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
        langs: [fallbackLanguage as SupportedLanguages],
        preferredHighlighter: "shiki-js",
      });
      return { highlighter: fallbackHighlighter, language: fallbackLanguage };
    });

  highlighterPromiseCache.set(normalizedLanguage, promise);
  return promise;
}

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock">
      <button
        type="button"
        className="chat-markdown-copy-button"
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
      {children}
    </div>
  );
}

const MarkdownFileLinkIcon = memo(function MarkdownFileLinkIcon(props: {
  targetPath: string;
  kind: MarkdownPathKind;
  theme: "light" | "dark";
}) {
  const pathValue = fileIconPathValue(props.targetPath);
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const iconUrl = useMemo(
    () =>
      props.kind === "directory" ? null : getVscodeIconUrlForEntry(pathValue, "file", props.theme),
    [pathValue, props.kind, props.theme],
  );

  if (props.kind === "directory" || iconUrl === null) {
    return <FolderIcon aria-hidden="true" className="chat-markdown-file-link-icon" />;
  }

  if (failedIconUrl === iconUrl) {
    return <FileIcon aria-hidden="true" className="chat-markdown-file-link-icon" />;
  }

  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      className="chat-markdown-file-link-icon"
      loading="lazy"
      onError={() => setFailedIconUrl(iconUrl)}
    />
  );
});

function MarkdownFileLink(props: {
  href: string | undefined;
  label: string | undefined;
  targetPath: string;
  kind: MarkdownPathKind;
  viewerPath: string | null;
  theme: "light" | "dark";
  className?: string | undefined;
  onOpenFilePath?: ((relativePath: string) => void) | undefined;
}) {
  const displayLabel = normalizeMarkdownFileLinkLabel(props.label, props.targetPath);

  return (
    <a
      href={props.href}
      className={cn("chat-markdown-file-link", props.className)}
      title={props.viewerPath ?? props.targetPath}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (props.viewerPath && props.onOpenFilePath) {
          props.onOpenFilePath(props.viewerPath);
          return;
        }
        const api = readNativeApi();
        if (api) {
          void api.shell.openInEditor(props.targetPath, preferredTerminalEditor());
        } else {
          console.warn("Native API not found. Unable to open file in editor.");
        }
      }}
    >
      <MarkdownFileLinkIcon targetPath={props.targetPath} kind={props.kind} theme={props.theme} />
      <span className="truncate">{displayLabel}</span>
    </a>
  );
}

function MarkdownGitHubLink(props: {
  href: string;
  label: string;
  className?: string | undefined;
}) {
  return (
    <a
      href={props.href}
      className={cn("chat-markdown-file-link chat-markdown-github-link", props.className)}
      title={props.href}
      target="_blank"
      rel="noreferrer"
    >
      <GitHubIcon aria-hidden="true" className="chat-markdown-file-link-icon" />
      <span className="truncate">{props.label}</span>
    </a>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const requestedLanguage = normalizeSyntaxLanguage(extractFenceLanguage(className));
  const cacheKey = createHighlightCacheKey(code, requestedLanguage, themeName);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  const { highlighter, language } = use(getHighlighterPromise(requestedLanguage));
  const highlightedHtml = useMemo(
    () => highlighter.codeToHtml(code, { lang: language, theme: themeName }),
    [code, highlighter, language, themeName],
  );

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

function ChatMarkdown({
  text,
  cwd,
  isStreaming = false,
  variant = "assistant",
  onOpenFilePath,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownComponents = useMemo<Components>(
    () => ({
      a({ node: _node, href, ...props }) {
        const githubLink = parseMarkdownGitHubLink(href);
        if (githubLink) {
          const label = nodeToPlainText(props.children).trim();
          return (
            <MarkdownGitHubLink
              href={githubLink.href}
              label={label.length > 0 && label !== href ? label : githubLink.label}
              className={props.className}
            />
          );
        }

        const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
        if (!targetPath) {
          return <a {...props} href={href} target="_blank" rel="noreferrer" />;
        }
        const viewerPath = resolveMarkdownFileViewerPath(href, cwd);
        const label = nodeToPlainText(props.children);

        return (
          <MarkdownFileLink
            href={href}
            label={label}
            targetPath={targetPath}
            kind={inferMarkdownPathKind(targetPath)}
            viewerPath={viewerPath}
            theme={resolvedTheme}
            className={props.className}
            onOpenFilePath={onOpenFilePath}
          />
        );
      },
      code({ node: _node, className, children, ...props }) {
        const codeText = nodeToPlainText(children);
        if (!className) {
          const literalLink = parseMarkdownFileLinkLiteral(codeText);
          if (literalLink) {
            const githubLink = parseMarkdownGitHubLink(literalLink.href);
            if (githubLink) {
              return (
                <MarkdownGitHubLink
                  href={githubLink.href}
                  label={literalLink.label.length > 0 ? literalLink.label : githubLink.label}
                />
              );
            }

            const targetPath = resolveMarkdownFileLinkTarget(literalLink.href, cwd);
            if (targetPath) {
              return (
                <MarkdownFileLink
                  href={literalLink.href}
                  label={literalLink.label}
                  targetPath={targetPath}
                  kind={inferMarkdownPathKind(targetPath)}
                  viewerPath={resolveMarkdownFileViewerPath(literalLink.href, cwd)}
                  theme={resolvedTheme}
                  onOpenFilePath={onOpenFilePath}
                />
              );
            }
          }

          const githubLink = parseMarkdownGitHubLink(codeText);
          if (githubLink) {
            return <MarkdownGitHubLink href={githubLink.href} label={githubLink.label} />;
          }

          const inlinePathTarget = resolveMarkdownFileLinkTarget(codeText, cwd);
          if (inlinePathTarget) {
            return (
              <MarkdownFileLink
                href={codeText}
                label={codeText}
                targetPath={inlinePathTarget}
                kind={inferMarkdownPathKind(inlinePathTarget)}
                viewerPath={resolveMarkdownFileViewerPath(codeText, cwd)}
                theme={resolvedTheme}
                onOpenFilePath={onOpenFilePath}
              />
            );
          }
        }

        return (
          <code {...props} className={className}>
            {children}
          </code>
        );
      },
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        if (isStreaming || codeBlock.code.length > MAX_HIGHLIGHTED_CODE_CHARS) {
          return (
            <MarkdownCodeBlock code={codeBlock.code}>
              <pre {...props}>
                <code className={codeBlock.className}>{codeBlock.code}</code>
              </pre>
            </MarkdownCodeBlock>
          );
        }

        return (
          <MarkdownCodeBlock code={codeBlock.code}>
            <Suspense fallback={<pre {...props}>{children}</pre>}>
              <SuspenseShikiCodeBlock
                className={codeBlock.className}
                code={codeBlock.code}
                themeName={diffThemeName}
                isStreaming={isStreaming}
              />
            </Suspense>
          </MarkdownCodeBlock>
        );
      },
    }),
    [cwd, diffThemeName, isStreaming, onOpenFilePath, resolvedTheme],
  );

  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed",
        variant === "user" ? "chat-markdown-user text-foreground" : "text-foreground/80",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
