import { textInputProps } from "../textInputProps";
import { findNext, findPrevious, openSearchPanel } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CodeEditor } from "./CodeEditor";
import { DocxPreview, PptxPreview, XlsxPreview } from "./OfficePreview";
import { apiUrl } from "../api";
import { useImeGuard } from "../imeGuard";
import { useNativeOccluder } from "../nativeViewOcclusion";
import { revealPath } from "../openExternal";
import { activeHtab, findLeaf, remoteSessionFor, useStore } from "../state/store";
import { sendCommand, terminalSessionId } from "../terminal/manager";
import {
  ChevronIcon,
  CloseIcon,
  CollapseAllIcon,
  EditIcon,
  FileEntryIcon,
  FolderIcon,
  PanelLeftCloseIcon,
  PreviewIcon,
  RefreshIcon,
  RestoreExpandedIcon,
  RevealFolderIcon,
  SourceIcon,
  TrashIcon,
} from "./icons";

/** Base name only (Windows- and Unix-style separators both) — the preview
 *  header shows just this, not the full path (that's still in its title). */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Quote a path as a `cd` argument — works as typed in both POSIX shells
 *  (bash/zsh/fish) and PowerShell for the vast majority of paths; only ones
 *  containing a literal `"` would need shell-specific escaping. */
function quoteForShell(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

/** An /api/fs URL. `remote` is the SSH terminal session whose host the path
 *  lives on (see remoteSessionFor); without it the path is local. */
function fsUrl(endpoint: string, params: Record<string, string>, remote?: string): string {
  return `${apiUrl()}/api/fs/${endpoint}?${new URLSearchParams(remote ? { ...params, session: remote } : params)}`;
}

/** POST a JSON body to an /api/fs endpoint; rejects with the server's error. */
async function fsPost(endpoint: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${apiUrl()}/api/fs/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error || `HTTP ${res.status}`);
}

/** Whether `path` is `base` itself or somewhere beneath it. */
function isWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

type MediaKind = "image" | "video" | "audio" | "pdf" | "docx" | "xlsx" | "pptx";

function mediaKindForPath(path: string): MediaKind | null {
  const ext = path.split(/[?#]/)[0].toLowerCase().match(/\.([^.\\/]+)$/)?.[1];
  if (!ext) return null;
  if (["apng", "avif", "bmp", "gif", "ico", "jpg", "jpeg", "png", "svg", "webp"].includes(ext)) return "image";
  if (["m4v", "mov", "mp4", "ogv", "webm"].includes(ext)) return "video";
  if (["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  if (ext === "pptx") return "pptx";
  return null;
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}

function isHtmlPath(path: string): boolean {
  return /\.(html|htm)$/i.test(path);
}

function isSvgPath(path: string): boolean {
  return /\.svg$/i.test(path);
}

function isCsvPath(path: string): boolean {
  return /\.(csv|tsv)$/i.test(path);
}

/** Text files that have a rendered view to toggle to, alongside their source. */
function hasRenderedView(path: string): boolean {
  return isMarkdownPath(path) || isHtmlPath(path) || isSvgPath(path) || isCsvPath(path);
}

/** Rows beyond this aren't rendered — a big CSV would otherwise stall the DOM. */
const CSV_ROW_LIMIT = 2000;

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function CsvPreview({ path, content }: { path: string; content: string }) {
  const rows = useMemo(
    () => parseDelimited(content, /\.tsv$/i.test(path) ? "\t" : ","),
    [path, content],
  );
  if (!rows.length) return <div className="file-tree-message">Empty file.</div>;
  const [head, ...body] = rows;
  const shown = body.slice(0, CSV_ROW_LIMIT);
  // Ragged files are common (trailing commas, extra fields); size the table to
  // the widest row shown so no cell is silently dropped.
  const cols = shown.reduce((n, r) => Math.max(n, r.length), head.length);
  return (
    <div className="csv-preview">
      <table>
        <thead>
          <tr>
            {Array.from({ length: cols }, (_, i) => (
              <th key={i}>{head[i] ?? ""}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>
              {Array.from({ length: cols }, (_, c) => (
                <td key={c}>{r[c] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > shown.length && (
        <div className="file-tree-message">
          Showing the first {CSV_ROW_LIMIT} rows of {body.length}. Switch to the source view for the rest.
        </div>
      )}
    </div>
  );
}

/** Directory part of a path — the base a markdown doc's relative links and
 *  image sources resolve against. */
function dirname(path: string): string {
  const cut = path.replace(/[\\/]+$/, "").search(/[\\/][^\\/]*$/);
  return cut < 0 ? "" : path.slice(0, cut);
}

/** Resolve a markdown link/image target to something the browser can load.
 *  Absolute URLs and data: URIs pass through; a repo-relative path (the common
 *  case — `docs/hero.png`) is resolved against the doc's own directory
 *  and served through the media endpoint, since the web app has no filesystem. */
function resolveDocUrl(target: string, baseDir: string, remote?: string): string {
  if (/^(https?:|data:|mailto:|#)/i.test(target)) return target;
  const abs = /^([\\/]|[A-Za-z]:)/.test(target) || !baseDir ? target : `${baseDir}/${target}`;
  const parts: string[] = [];
  for (const seg of abs.split(/[\\/]/)) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const normalized = (abs.startsWith("/") ? "/" : "") + parts.join("/");
  return fsUrl("media", { path: normalized }, remote);
}

/** `baseDir` is the containing directory of the markdown file being previewed;
 *  it's what relative image sources resolve against. */
function inlineMarkdown(text: string, baseDir = "", remote?: string): Array<string | JSX.Element> {
  const out: Array<string | JSX.Element> = [];
  // Order matters. A linked image `[![alt](src)](href)` must be tried before
  // the bare image inside it, and images before links, or each longer form
  // gets shredded into a stray `[`/`!` plus whatever the shorter form matched.
  const re =
    /(`[^`]+`|\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)|!\[[^\]]*\]\([^)]+\)|\*\*(?:[^*]|\*(?!\*))+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(re)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) out.push(<code key={i++}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("![")) {
      const img = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(token);
      if (img) out.push(<img key={i++} src={resolveDocUrl(img[2], baseDir, remote)} alt={img[1]} />);
      else out.push(token);
    }
    // Emphasis recurses: its content can itself hold links, code, or images.
    else if (token.startsWith("**"))
      out.push(<strong key={i++}>{inlineMarkdown(token.slice(2, -2), baseDir, remote)}</strong>);
    else if (token.startsWith("*"))
      out.push(<em key={i++}>{inlineMarkdown(token.slice(1, -1), baseDir, remote)}</em>);
    else {
      // Greedy label so a linked image `[![alt](src)](href)` splits at the
      // final `](`; the label then recurses and renders as the image.
      const link = /^\[(.+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(token);
      out.push(
        <a key={i++} href={link?.[2] ?? "#"} target="_blank" rel="noreferrer">
          {link ? inlineMarkdown(link[1], baseDir, remote) : token}
        </a>
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function MarkdownPreview({ content, baseDir, remote }: { content: string; baseDir: string; remote?: string }) {
  const blocks: JSX.Element[] = [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: Array<{ ordered: boolean; text: string }> = [];
  let code: string[] | null = null;
  let codeKey = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(<p key={`p-${blocks.length}`}>{inlineMarkdown(paragraph.join(" "), baseDir, remote)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    const ordered = list[0].ordered;
    const Tag = ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={`l-${blocks.length}`}>
        {list.map((item, idx) => (
          <li key={idx}>{inlineMarkdown(item.text, baseDir, remote)}</li>
        ))}
      </Tag>
    );
    list = [];
  };

  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) {
        blocks.push(<pre key={`c-${codeKey++}`}><code>{code.join("\n")}</code></pre>);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={`h-${blocks.length}`}>{inlineMarkdown(heading[2], baseDir, remote)}</Tag>);
      continue;
    }
    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push(<hr key={`hr-${blocks.length}`} />);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push(<blockquote key={`q-${blocks.length}`}>{inlineMarkdown(quote[1], baseDir, remote)}</blockquote>);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      list.push({ ordered: !!ordered, text: (bullet ?? ordered)![1] });
      continue;
    }
    paragraph.push(line.trim());
  }
  if (code) blocks.push(<pre key={`c-${codeKey++}`}><code>{code.join("\n")}</code></pre>);
  flushParagraph();
  flushList();

  return <div className="markdown-preview">{blocks}</div>;
}

interface FsEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

/** A directory's fetched children, keyed by its own absolute path. */
interface DirState {
  status: "loading" | "loaded" | "error";
  entries?: FsEntry[];
  error?: string;
}

function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function formatDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  // Fixed to "en-US", not the system locale — the rest of this UI is English
  // ("Reveal in Finder", column headers, …), and a locale like zh-CN produces
  // "2025年6月25日", which is both inconsistent and too wide for this column,
  // wrapping to two lines.
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

/** The name box for a new file/folder, sitting where the entry will appear.
 *  Enter creates it; Esc, or leaving it empty, drops the draft. */
function NewEntryRow({
  kind,
  depth,
  onCreate,
  onCancel,
}: {
  kind: NewEntryKind;
  depth: number;
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const ime = useImeGuard();
  return (
    <div className="file-tree-row menu-open" style={{ paddingLeft: 4 + depth * 9 }}>
      <span className="file-tree-twisty" />
      <span className="file-tree-icon">{kind === "folder" ? <FolderIcon /> : <FileEntryIcon />}</span>
      <input
        {...textInputProps}
        {...ime.props}
        className="tree-rename file-tree-rename"
        autoFocus
        placeholder={kind === "folder" ? "Folder name" : "File name"}
        onBlur={(e) => {
          const name = e.target.value.trim();
          if (name) onCreate(name);
          else onCancel();
        }}
        onKeyDown={(e) => {
          if (ime.handled(e)) return;
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            (e.target as HTMLInputElement).value = "";
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}

/**
 * One row + (if a directory, expanded) its children, to any depth — mirrors
 * TreeSidebar's TreeItem. Clicking a folder expands/collapses it IN PLACE;
 * there is no "navigate into" — the root stays the pane's terminal cwd.
 * Clicking a file loads it into the preview panel on the right — the tree
 * itself never changes shape or gets replaced.
 */
function FileTreeRow({
  path,
  entry,
  depth,
  dirs,
  expanded,
  selectedPath,
  menuPath,
  renamingPath,
  creating,
  onToggleDir,
  onSelectFile,
  onContextMenu,
  onRename,
  onCancelRename,
  onCreate,
  onCancelCreate,
}: {
  path: string;
  entry: FsEntry;
  depth: number;
  dirs: Record<string, DirState>;
  expanded: Set<string>;
  selectedPath: string | null;
  /** The row a context menu is open on — kept highlighted while it is. */
  menuPath: string | null;
  /** The row whose name is being edited in place. */
  renamingPath: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onContextMenu: (path: string, entry: FsEntry, x: number, y: number) => void;
  onRename: (path: string, name: string) => void;
  onCancelRename: () => void;
  /** A new entry being named — drafted inside this folder when `dir` is it. */
  creating: Creating | null;
  onCreate: (dir: string, name: string, kind: NewEntryKind) => void;
  onCancelCreate: () => void;
}) {
  const isOpen = entry.isDir && expanded.has(path);
  const state = dirs[path];
  const renaming = renamingPath === path;
  const ime = useImeGuard();

  return (
    <>
      <div
        className={`file-tree-row ${!entry.isDir && path === selectedPath ? "selected" : ""} ${path === menuPath ? "menu-open" : ""}`}
        style={{ paddingLeft: 4 + depth * 9 }}
        onClick={() => {
          if (renaming) return;
          if (entry.isDir) onToggleDir(path);
          else onSelectFile(path);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(path, entry, e.clientX, e.clientY);
        }}
      >
        <span className="file-tree-twisty">
          {entry.isDir && <ChevronIcon dir={isOpen ? "down" : "right"} />}
        </span>
        <span className="file-tree-icon">{entry.isDir ? <FolderIcon /> : <FileEntryIcon />}</span>
        {renaming ? (
          <input
            {...textInputProps}
            {...ime.props}
            className="tree-rename file-tree-rename"
            autoFocus
            defaultValue={entry.name}
            onFocus={(e) => {
              // Select the stem only, like Finder — the extension rarely changes.
              const dot = entry.isDir ? -1 : entry.name.lastIndexOf(".");
              e.target.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
            }}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== entry.name) onRename(path, name);
              else onCancelRename();
            }}
            onKeyDown={(e) => {
              if (ime.handled(e)) return;
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              else if (e.key === "Escape") {
                (e.target as HTMLInputElement).value = entry.name;
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        ) : (
          <span className="file-tree-name">{entry.name}</span>
        )}
        <span className="file-tree-size">{formatSize(entry.size, entry.isDir)}</span>
        <span className="file-tree-date">{formatDate(entry.mtimeMs)}</span>
      </div>
      {isOpen && creating?.dir === path && (
        <NewEntryRow
          kind={creating.kind}
          depth={depth + 1}
          onCreate={(name) => onCreate(path, name, creating.kind)}
          onCancel={onCancelCreate}
        />
      )}
      {isOpen && state?.status === "error" && (
        <div className="file-tree-message" style={{ paddingLeft: 4 + (depth + 1) * 9 }}>
          {state.error}
        </div>
      )}
      {isOpen && state?.status === "loaded" && state.entries!.length === 0 && creating?.dir !== path && (
        <div className="file-tree-message" style={{ paddingLeft: 4 + (depth + 1) * 9 }}>
          Empty directory
        </div>
      )}
      {isOpen &&
        state?.status === "loaded" &&
        state.entries!.map((child) => (
          <FileTreeRow
            key={child.name}
            path={`${path}/${child.name}`}
            entry={child}
            depth={depth + 1}
            dirs={dirs}
            expanded={expanded}
            selectedPath={selectedPath}
            menuPath={menuPath}
            renamingPath={renamingPath}
            creating={creating}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
            onContextMenu={onContextMenu}
            onRename={onRename}
            onCancelRename={onCancelRename}
            onCreate={onCreate}
            onCancelCreate={onCancelCreate}
          />
        ))}
    </>
  );
}

type NewEntryKind = "file" | "folder";

/** A name being typed for a new entry, shown as a draft row inside `dir`. */
interface Creating {
  dir: string;
  kind: NewEntryKind;
}

interface EntryMenu {
  /** The right-clicked entry, or the tree's root for its empty space. */
  path: string;
  /** Null for the empty space below the rows — only "New …" applies there. */
  entry: FsEntry | null;
  x: number;
  y: number;
  /** Delete was clicked once — the menu now asks to confirm it. */
  confirmDelete: boolean;
}

const ENTRY_MENU_WIDTH = 220;
const ENTRY_MENU_HEIGHT = 170;
const ENTRY_MENU_MARGIN = 8;

/** Right-click menu on a tree row: new file/folder, rename in place, or
 *  delete (confirmed). */
function FileEntryMenu({
  menu,
  onNew,
  onRename,
  onDelete,
  onConfirmDelete,
  onClose,
}: {
  menu: EntryMenu;
  onNew: (kind: NewEntryKind) => void;
  onRename: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onClose: () => void;
}) {
  const ref = useNativeOccluder<HTMLDivElement>(`file-tree-entry-menu-${useId()}`);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [ref, onClose]);

  const x = Math.max(ENTRY_MENU_MARGIN, Math.min(menu.x, window.innerWidth - ENTRY_MENU_WIDTH - ENTRY_MENU_MARGIN));
  const y = Math.max(ENTRY_MENU_MARGIN, Math.min(menu.y, window.innerHeight - ENTRY_MENU_HEIGHT - ENTRY_MENU_MARGIN));
  return (
    <div className="agent-context-menu file-tree-entry-menu" role="menu" ref={ref} style={{ left: x, top: y }}>
      {menu.confirmDelete && menu.entry ? (
        <>
          <div className="file-tree-entry-menu-prompt" title={menu.entry.name}>
            Delete “{menu.entry.name}”{menu.entry.isDir ? " and everything in it" : ""}? This can’t be undone.
          </div>
          <button type="button" role="menuitem" className="danger" autoFocus onClick={onConfirmDelete}>
            <TrashIcon />
            Delete
          </button>
          <button type="button" role="menuitem" onClick={onClose}>
            <CloseIcon />
            Cancel
          </button>
        </>
      ) : (
        <>
          {/* Creating needs a folder to create in — a file only gets its own actions. */}
          {(!menu.entry || menu.entry.isDir) && (
            <>
              <button type="button" role="menuitem" onClick={() => onNew("file")}>
                <FileEntryIcon />
                New File
              </button>
              <button type="button" role="menuitem" onClick={() => onNew("folder")}>
                <FolderIcon />
                New Folder
              </button>
            </>
          )}
          {menu.entry && (
            <>
              {menu.entry.isDir && <div className="agent-context-menu-separator" />}
              <button type="button" role="menuitem" onClick={onRename}>
                <EditIcon />
                Rename
              </button>
              <div className="agent-context-menu-separator" />
              <button type="button" role="menuitem" className="danger" onClick={onDelete}>
                <TrashIcon />
                Delete
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

interface Selected {
  path: string;
  status: "loading" | "text" | "binary" | "error";
  content?: string;
  truncated?: boolean;
  error?: string;
  /** Modified time as of the read — local files only; how a change on disk is spotted. */
  mtimeMs?: number;
  /** When this copy was read; a new value pushes it into the open editor. */
  loadedAt?: number;
}

/** Read an open file for its tab. Never rejects — a failure is an error tab. */
async function readFile(path: string, remote?: string): Promise<Selected> {
  try {
    const res = await fetch(fsUrl("read", { path }, remote));
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    const loadedAt = Date.now();
    return body.binary
      ? { path, status: "binary", mtimeMs: body.mtimeMs, loadedAt }
      : { path, status: "text", content: body.content, truncated: !!body.truncated, mtimeMs: body.mtimeMs, loadedAt };
  } catch (e) {
    return { path, status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

type FindDir = "open" | "next" | "prev";
const FILE_FIND_EVENT = "termany:file-find";

/** Route the find shortcuts (⌘F, ⌘G, ⇧⌘G) to a files-view pane's open file,
 *  which searches with its editor's own find panel instead of the terminal
 *  find bar. */
export function requestFileFind(paneId: string, dir: FindDir) {
  window.dispatchEvent(new CustomEvent(FILE_FIND_EVENT, { detail: { paneId, dir } }));
}

/** The open files, as tabs across the top of the preview. A tab with unsaved
 *  edits shows a dot in place of its close button (until hovered), and asks
 *  for a second click before it lets those edits go. */
function FileTabStrip({
  tabs,
  activePath,
  dirtyPaths,
  onActivate,
  onClose,
}: {
  tabs: Selected[];
  activePath: string;
  dirtyPaths: Set<string>;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  useEffect(() => {
    ref.current?.querySelector(".file-preview-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath, tabs.length]);

  const close = (path: string) => {
    if (dirtyPaths.has(path) && confirmPath !== path) {
      setConfirmPath(path);
      return;
    }
    setConfirmPath(null);
    onClose(path);
  };

  return (
    <div
      className="file-preview-tabs"
      ref={ref}
      role="tablist"
      onWheel={(e) => {
        // A plain mouse wheel only scrolls vertically; turn it sideways here.
        if (e.deltaY && !e.deltaX) e.currentTarget.scrollLeft += e.deltaY;
      }}
    >
      {tabs.map((tab) => {
        const dirty = dirtyPaths.has(tab.path);
        const confirming = confirmPath === tab.path && dirty;
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={tab.path === activePath}
            className={`file-preview-tab ${tab.path === activePath ? "active" : ""} ${dirty ? "dirty" : ""} ${confirming ? "confirming" : ""}`}
            title={tab.path}
            onClick={() => onActivate(tab.path)}
            onAuxClick={(e) => {
              if (e.button === 1) close(tab.path);
            }}
            onMouseLeave={() => confirming && setConfirmPath(null)}
          >
            <span className="file-preview-tab-name">{basename(tab.path)}</span>
            <button
              className="file-preview-tab-close"
              title={confirming ? "Unsaved changes — click again to discard them" : "Close"}
              onClick={(e) => {
                e.stopPropagation();
                close(tab.path);
              }}
            >
              <span className="file-preview-dirty" />
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The right-hand preview/editor panel for ONE open file. Every open tab keeps
 * its own instance mounted (only the active one shown), so switching tabs
 * doesn't throw away an editor's unsaved edits, scroll, or undo history.
 * Keyed on the file's path by the caller, so a renamed file gets a fresh
 * instance rather than stale state.
 */
function FilePreview({
  paneId,
  selected,
  visible,
  dirty,
  tabStrip,
  remote,
  dark,
  treeCollapsed,
  onToggleTree,
  onDirtyChange,
  onReload,
  onClose,
  closeArmed,
}: {
  /** The files-view pane this sits in — the target of its find shortcuts. */
  paneId: string;
  selected: Selected;
  /** The active tab, and the preview column is showing. */
  visible: boolean;
  /** Has unsaved edits. */
  dirty: boolean;
  /** Shared tab strip, in the header where the file name would go. */
  tabStrip: React.ReactNode;
  /** SSH session the file lives on — no Finder to reveal it in. */
  remote?: string;
  dark: boolean;
  treeCollapsed: boolean;
  onToggleTree: () => void;
  onDirtyChange: (path: string, dirty: boolean) => void;
  /** Re-read the file from disk; `force` throws away unsaved edits. */
  onReload: (force: boolean) => void;
  /** Close every tab. Armed = asked once already, because some have unsaved edits. */
  onClose: () => void;
  closeArmed: boolean;
}) {
  // Unsaved-edit state lives with the tab strip, which marks the tab.
  const setDirty = useCallback((value: boolean) => onDirtyChange(selected.path, value), [onDirtyChange, selected.path]);
  const panelRef = useRef<HTMLDivElement>(null);
  // A hidden tab stays mounted — don't let its video or audio keep playing.
  useEffect(() => {
    if (visible) return;
    panelRef.current?.querySelectorAll("video, audio").forEach((m) => (m as HTMLMediaElement).pause());
  }, [visible]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [reloadArmed, setReloadArmed] = useState(false);
  useEffect(() => {
    if (!dirty) setReloadArmed(false);
  }, [dirty]);

  const editorView = () => {
    const el = panelRef.current?.querySelector<HTMLElement>(".cm-editor");
    return el ? EditorView.findFromDOM(el) : null;
  };

  // Find runs in the editor's own search panel. A rendered view (Markdown,
  // CSV, …) has nothing to search in, so it flips to the source first and
  // runs the find once the editor is there.
  const pendingFind = useRef<FindDir | null>(null);
  const runFind = (dir: FindDir) => {
    const view = editorView();
    if (!view) return;
    if (dir === "open") openSearchPanel(view);
    else if (dir === "next") findNext(view);
    else findPrevious(view);
  };
  const runFindRef = useRef(runFind);
  runFindRef.current = runFind;
  const showsRendered =
    selected.status === "text" && !selected.truncated && !showSource && hasRenderedView(selected.path);
  useEffect(() => {
    if (!visible || selected.status !== "text") return;
    const onFind = (event: Event) => {
      const { paneId: target, dir } = (event as CustomEvent<{ paneId: string; dir: FindDir }>).detail;
      if (target !== paneId) return;
      if (showsRendered) {
        pendingFind.current = dir;
        setShowSource(true);
      } else {
        runFindRef.current(dir);
      }
    };
    window.addEventListener(FILE_FIND_EVENT, onFind);
    return () => window.removeEventListener(FILE_FIND_EVENT, onFind);
  }, [visible, paneId, selected.status, showsRendered]);
  useEffect(() => {
    const dir = pendingFind.current;
    pendingFind.current = null;
    if (dir && showSource) runFindRef.current(dir);
  }, [showSource]);

  // Reveal (not open) — opening a file with the OS default app needs a Tauri
  // permission (opener:allow-open-path) this app doesn't grant, and revealing
  // it selected in Finder/Explorer covers the same need without asking for it.
  const revealInFinder = (path: string) => {
    setOpenError(null);
    void revealPath(path).then((err) => {
      if (err) setOpenError(err);
    });
  };

  const save = useCallback((path: string, text: string) => {
    setSaveError(null);
    fetch(`${apiUrl()}/api/fs/write`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content: text, session: remote }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error || `HTTP ${res.status}`);
        // Typing that landed while the save was in flight is still unsaved.
        if (editorView()?.state.doc.toString() === text) setDirty(false);
      })
      .catch((e) => setSaveError(e instanceof Error ? e.message : String(e)));
  }, [remote, setDirty]);

  const header = (
    <div className="file-tree-head">
      <button className="pane-btn" title={treeCollapsed ? "Show file tree" : "Collapse file tree"} onClick={onToggleTree}>
        <PanelLeftCloseIcon />
      </button>
      {tabStrip}
      {selected.status === "text" && !selected.truncated && hasRenderedView(selected.path) && (
        <button
          className="pane-btn"
          title={showSource ? "Show rendered preview" : "Show source"}
          onClick={() => setShowSource((v) => !v)}
        >
          {showSource ? <PreviewIcon /> : <SourceIcon />}
        </button>
      )}
      <button
        className={`pane-btn ${reloadArmed ? "danger" : ""}`}
        title={reloadArmed ? "Unsaved changes — click again to discard them and reload" : "Reload from disk"}
        onClick={() => {
          if (dirty && !reloadArmed) {
            setReloadArmed(true);
            return;
          }
          setReloadArmed(false);
          onReload(true);
        }}
        onMouseLeave={() => setReloadArmed(false)}
      >
        <RefreshIcon />
      </button>
      {!remote && (
        <button className="pane-btn" title="Reveal in Finder" onClick={() => revealInFinder(selected.path)}>
          <RevealFolderIcon />
        </button>
      )}
      <button
        className={`pane-btn ${closeArmed ? "danger" : ""}`}
        title={closeArmed ? "Some files have unsaved changes — click again to discard them" : "Close all files"}
        onClick={onClose}
      >
        <CloseIcon />
      </button>
    </div>
  );

  if (selected.status === "loading") {
    return (
      <div className="file-preview-panel" ref={panelRef} hidden={!visible}>
        {header}
      </div>
    );
  }

  if (selected.status === "binary") {
    const mediaKind = mediaKindForPath(selected.path);
    // The modified time busts the cache, so a reload shows the new bytes.
    const mediaSrc = fsUrl(
      "media",
      selected.mtimeMs ? { path: selected.path, v: String(selected.mtimeMs) } : { path: selected.path },
      remote,
    );
    if (mediaKind) {
      return (
        <div className="file-preview-panel" ref={panelRef} hidden={!visible}>
          {header}
          <div className={`file-media-preview ${mediaKind}`}>
            {mediaKind === "image" && <img src={mediaSrc} alt={basename(selected.path)} />}
            {mediaKind === "video" && <video src={mediaSrc} controls playsInline />}
            {mediaKind === "audio" && <audio src={mediaSrc} controls />}
            {mediaKind === "pdf" && <iframe src={mediaSrc} title={basename(selected.path)} />}
            {mediaKind === "docx" && <DocxPreview src={mediaSrc} />}
            {mediaKind === "xlsx" && <XlsxPreview src={mediaSrc} />}
            {mediaKind === "pptx" && <PptxPreview src={mediaSrc} />}
          </div>
          {openError && <div className="file-tree-message file-preview-error">{openError}</div>}
        </div>
      );
    }
    return (
      <div className="file-preview-panel" ref={panelRef} hidden={!visible}>
        {header}
        <div className="file-unsupported-preview">
          <FileEntryIcon />
          {!remote && (
            <button className="file-open-finder-btn" onClick={() => revealInFinder(selected.path)}>
              Reveal in Finder
            </button>
          )}
        </div>
        {openError && <div className="file-tree-message file-preview-error">{openError}</div>}
      </div>
    );
  }

  if (selected.status === "error") {
    return (
      <div className="file-preview-panel" ref={panelRef} hidden={!visible}>
        {header}
        <div className="file-tree-message">{selected.error}</div>
      </div>
    );
  }

  // Which rendered (non-source) view this file gets, if any. A truncated
  // preview is only a prefix of the file, so it always falls back to source.
  const rendered =
    showSource || selected.truncated
      ? null
      : isMarkdownPath(selected.path)
        ? "markdown"
        : isHtmlPath(selected.path)
          ? "html"
          : isSvgPath(selected.path)
            ? "svg"
            : isCsvPath(selected.path)
              ? "csv"
              : null;

  return (
    <div className="file-preview-panel" ref={panelRef} hidden={!visible}>
      {header}
      {selected.truncated && (
        <div className="file-tree-message">
          {remote
            ? "File is larger than the 2 MB preview limit — showing (read-only) the start of it."
            : 'File is larger than the 2 MB preview limit — showing (read-only) the start of it. Use "Reveal in Finder" to open the whole file yourself.'}
        </div>
      )}
      {saveError && <div className="file-tree-message file-preview-error">Save failed: {saveError}</div>}
      {openError && <div className="file-tree-message file-preview-error">{openError}</div>}
      {rendered === "markdown" ? (
        <MarkdownPreview content={selected.content ?? ""} baseDir={dirname(selected.path)} remote={remote} />
      ) : rendered === "html" ? (
        <iframe
          className="html-preview"
          title={basename(selected.path)}
          sandbox=""
          srcDoc={selected.content ?? ""}
        />
      ) : rendered === "svg" ? (
        <div className="file-media-preview image">
          <img src={`data:image/svg+xml;utf8,${encodeURIComponent(selected.content ?? "")}`} alt={basename(selected.path)} />
        </div>
      ) : rendered === "csv" ? (
        <CsvPreview path={selected.path} content={selected.content ?? ""} />
      ) : (
        <CodeEditor
          path={selected.path}
          content={selected.content ?? ""}
          loadedAt={selected.loadedAt}
          dark={dark}
          readOnly={!!selected.truncated}
          onDirtyChange={setDirty}
          onSave={(text) => save(selected.path, text)}
        />
      )}
    </div>
  );
}

interface FileTreeState {
  root: string | null;
  rootError: string | null;
  dirs: Record<string, DirState>;
  expanded: Set<string>;
  collapsedFrom: Set<string> | null;
  /** Open files, in tab order. */
  tabs: Selected[];
  activePath: string | null;
  /** Last cwd resolved from the session — see `lastKnownCwd` below. */
  lastCwd: string | null;
}

function emptyFileTreeState(): FileTreeState {
  return { root: null, rootError: null, dirs: {}, expanded: new Set(), collapsedFrom: null, tabs: [], activePath: null, lastCwd: null };
}

/**
 * Maximizing a not-yet-split pane (Wave-style magnify, from the pane header)
 * makes SplitView swap which component sits at that tree slot (a bare
 * `<PaneSlot solo>` instead of `<SplitTree>`'s), which forces React to
 * unmount and remount everything under it — including this component.
 * Ordinary useState would lose the tree/preview right when they'd just been
 * set. Stash it here instead, keyed by session id (the same trick the
 * terminal session registry uses for the same reason), so a remount just
 * re-hydrates instead of starting over.
 *
 * An entry existing is also how a remount is told apart from a fresh entry
 * into files view: the pane drops its own entry on the way out to the
 * terminal (see the unmount effect), so a cached root means "carry on where
 * we left off" and no entry means "resolve the root from the live cwd".
 */
const stateCache = new Map<string, FileTreeState>();

/**
 * A pane's alternative body: browse the filesystem rooted at `sessionId`'s
 * live shell cwd (resolved server-side — see /api/fs/list). By default it's
 * just the tree, full width. Clicking a file opens a preview alongside the
 * tree (two columns) right here in the pane — it does NOT take over the tab,
 * so the terminals around it stay usable; the preview's close button returns
 * to the full-width tree. Toggled from the pane header, alongside the
 * terminal it's attached to (not a global overlay), so each pane can
 * independently show its own terminal or its own file tree.
 */
export function FileTree(props: {
  sessionId: string;
  initialCwdFrom?: string;
  explicitRoot?: string;
  explicitSelected?: string;
}) {
  // Which machine the tree is on follows the pane's connection (or its
  // anchor's). A different machine is a different tree entirely, so it gets
  // its own cache entry and a fresh instance rather than morphing in place.
  const remote = useStore((s) => remoteSessionFor(s, props.sessionId));
  const cacheKey = remote ? `${props.sessionId}@${remote}` : props.sessionId;
  return <FileTreeView key={cacheKey} {...props} remote={remote} cacheKey={cacheKey} />;
}

function FileTreeView({
  sessionId,
  initialCwdFrom,
  explicitRoot,
  explicitSelected,
  remote,
  cacheKey,
}: {
  sessionId: string;
  /** A files-view pane has no PTY session of its own to resolve a live cwd
   *  from, so the root directory is instead resolved from WHATEVER pane was
   *  focused when this one was created (set once, at creation — see addPane
   *  in state/store.ts). Falls back to `sessionId` itself so toggling an
   *  EXISTING terminal pane to its file-tree view (which does have a live
   *  session) still opens rooted at that same pane's own cwd, as before. */
  initialCwdFrom?: string;
  explicitRoot?: string;
  explicitSelected?: string;
  /** SSH terminal session to browse the host of; undefined = local disk. */
  remote?: string;
  /** stateCache key: the pane, plus the host when it's remote. */
  cacheKey: string;
}) {
  const clearPathInPane = useStore((s) => s.clearPathInPane);
  // Read once per render — cheap, and the editor only needs it at creation
  // anyway (see CodeEditor's own comment on why it doesn't react to changes).
  const dark = document.documentElement.dataset.appearance !== "light";

  const initial = stateCache.get(cacheKey) ?? emptyFileTreeState();
  const [root, setRoot] = useState(initial.root);
  const [rootError, setRootError] = useState(initial.rootError);
  const [dirs, setDirs] = useState(initial.dirs);
  const [expanded, setExpanded] = useState(initial.expanded);
  // Snapshot of what was open right before the last "collapse all" — lets
  // the same button restore it, instead of collapsing being a one-way trip.
  const [collapsedFrom, setCollapsedFrom] = useState(initial.collapsedFrom);
  const [tabs, setTabs] = useState(initial.tabs);
  const [activePath, setActivePath] = useState(initial.activePath);
  const selected = tabs.find((t) => t.path === activePath) ?? null;
  // Tabs with unsaved edits — reported up by each tab's editor.
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set());
  const markDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyPaths((prev) => {
      if (prev.has(path) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);
  const [closeAllArmed, setCloseAllArmed] = useState(false);
  // Default to the narrowest the resizer allows (its drag clamp, below) —
  // the preview is the point of the split; the tree only needs to stay
  // usable, and can always be dragged wider.
  const [treeWidth, setTreeWidth] = useState(180);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  // Narrow panes show one column; this is whether it's the tree (with the
  // files still open behind it) rather than the active file.
  const [narrowTree, setNarrowTree] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  // Too narrow for two useful columns -> drop to one: the preview alone,
  // with its tree-toggle button doubling as "back to the tree". Measured
  // (not a container query) because the button's behavior switches too.
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length > 0]);

  // The address bar's own draft text — separate from `root` so typing
  // doesn't take effect until Enter, and doesn't get clobbered by a
  // background refresh while the input is focused.
  const [addressDraft, setAddressDraft] = useState(root ?? "");
  const [addressFocused, setAddressFocused] = useState(false);
  useEffect(() => {
    if (!addressFocused) setAddressDraft(root ?? "");
  }, [root, addressFocused]);

  // Always up to date without depending on the closure — read from a plain
  // ref inside async callbacks below instead of the `root` state variable,
  // which would otherwise be whatever it was when that callback was created.
  const rootRef = useRef(root);
  rootRef.current = root;
  // The session's live cwd as of the last resolveRootFromSession() call —
  // NOT necessarily the same as `root`, which a manual address-bar
  // navigation can point elsewhere. Compared against `root` when leaving
  // files view (see the sync-back-to-terminal effect below) to decide
  // whether the terminal actually needs a `cd`. Cached alongside the rest of
  // the state so a remount doesn't come back thinking it never resolved one.
  const lastKnownCwd = useRef<string | null>(initial.lastCwd);

  const loadDir = useCallback((path: string) => {
    setDirs((d) => ({ ...d, [path]: { status: "loading" } }));
    fetch(fsUrl("list", { path }, remote))
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        setDirs((d) => ({ ...d, [path]: { status: "loaded", entries: body.entries } }));
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setDirs((d) => ({ ...d, [path]: { status: "error", error: msg } }));
      });
  }, [remote]);

  // A genuinely new navigation (the address bar, below) — resets the tree,
  // since folders expanded under the OLD root have nothing to do with this one.
  const navigateTo = useCallback((path: string) => {
    setRootError(null);
    fetch(fsUrl("list", { path }, remote))
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        setRoot(body.path);
        setDirs({ [body.path]: { status: "loaded", entries: body.entries } });
        setExpanded(new Set());
        setCollapsedFrom(null);
      })
      .catch((e) => setRootError(e instanceof Error ? e.message : String(e)));
  }, [remote]);

  const openExplicitRoot = useCallback((path: string, selectedFile?: string) => {
    setRootError(null);
    fetch(fsUrl("list", { path }, remote))
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        // Files already open stay open; the requested one joins them as a tab.
        const cached = stateCache.get(cacheKey);
        let nextTabs = cached?.tabs ?? [];
        let nextActive = cached?.activePath ?? null;
        if (selectedFile) {
          if (!nextTabs.some((t) => t.path === selectedFile)) nextTabs = [...nextTabs, { path: selectedFile, status: "loading" }];
          nextActive = selectedFile;
        }
        setRoot(body.path);
        setDirs({ [body.path]: { status: "loaded", entries: body.entries } });
        setExpanded(new Set());
        setCollapsedFrom(null);
        setTabs(nextTabs);
        setActivePath(nextActive);
        if (selectedFile) setNarrowTree(false);
        stateCache.set(cacheKey, {
          root: body.path,
          rootError: null,
          dirs: { [body.path]: { status: "loaded", entries: body.entries } },
          expanded: new Set(),
          collapsedFrom: null,
          tabs: nextTabs,
          activePath: nextActive,
          lastCwd: lastKnownCwd.current,
        });
      })
      .catch((e) => setRootError(e instanceof Error ? e.message : String(e)));
  }, [cacheKey, remote]);

  // Resolve root from the pane's LIVE session cwd — how a FRESH entry into
  // files view picks where to start (a remount re-opens its cached root
  // instead; see the mount effect). Same path as the tree already shows ->
  // just refresh its listing in place; anywhere else -> start the tree over
  // there.
  const resolveRootFromSession = useCallback(() => {
    setRootError(null);
    // A remote tree asks the SSH session itself — the server finds that
    // host's live shell cwd; a local one resolves through the anchor as ever.
    fetch(fsUrl("list", { session: remote ?? initialCwdFrom ?? sessionId }))
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        lastKnownCwd.current = body.path;
        setRoot(body.path);
        if (rootRef.current !== null && rootRef.current === body.path) {
          setDirs((d) => ({ ...d, [body.path]: { status: "loaded", entries: body.entries } }));
        } else {
          setDirs({ [body.path]: { status: "loaded", entries: body.entries } });
          setExpanded(new Set());
          setCollapsedFrom(null);
        }
      })
      .catch((e) => setRootError(e instanceof Error ? e.message : String(e)));
  }, [sessionId, initialCwdFrom, remote]);

  // Mirror every render's state into the cache, keyed by this pane's session —
  // NOT scoped to a dependency list, since ANY of the pieces changing should
  // update it (cheap: a Map.set of a plain object).
  useEffect(() => {
    stateCache.set(cacheKey, { root, rootError, dirs, expanded, collapsedFrom, tabs, activePath, lastCwd: lastKnownCwd.current });
  });

  // Only hydrate from a DIFFERENT session's cache when `sessionId` actually
  // changes after mount — the lazy useState above already seeded the right
  // values for the initial mount (including a remount that preserved the
  // same session id), so re-doing it here would just discard what was just
  // restored.
  const lastSessionId = useRef<string>();
  const lastExplicitRoot = useRef<string>();
  useEffect(() => {
    if (lastSessionId.current !== undefined && lastSessionId.current !== cacheKey) {
      const cached = stateCache.get(cacheKey) ?? emptyFileTreeState();
      setRoot(cached.root);
      setRootError(cached.rootError);
      setDirs(cached.dirs);
      setExpanded(cached.expanded);
      setCollapsedFrom(cached.collapsedFrom);
      setTabs(cached.tabs);
      setActivePath(cached.activePath);
      lastKnownCwd.current = cached.lastCwd;
    }
    lastSessionId.current = cacheKey;
    if (explicitRoot && explicitRoot !== lastExplicitRoot.current) {
      lastExplicitRoot.current = explicitRoot;
      openExplicitRoot(explicitRoot, explicitSelected);
      clearPathInPane(sessionId);
    } else if (!explicitRoot) {
      if (lastExplicitRoot.current) {
        lastExplicitRoot.current = undefined;
        return;
      }
      // A cached root means this mount is a remount (maximize, split, tab
      // switch) of a tree that's already somewhere — stay there, open file
      // and all, and just re-list what's on screen in case it changed.
      // No cached root means a fresh entry into files view: start from the
      // session's live cwd.
      const cached = stateCache.get(cacheKey);
      if (cached?.root) {
        loadDir(cached.root);
        cached.expanded.forEach(loadDir);
      } else {
        resolveRootFromSession();
      }
    }
  }, [sessionId, cacheKey, explicitRoot, explicitSelected, resolveRootFromSession, openExplicitRoot, clearPathInPane, loadDir]);

  // The other half of keeping the tree and the terminal in sync: leaving
  // files view for terminal should `cd` the shell to wherever the tree
  // ended up (typically from a manual address-bar navigation — the terminal
  // has no way to know about that on its own), and forget the cached tree so
  // coming back later starts from the shell's cwd rather than reopening a
  // stale root. Only a genuine view switch — not a remount, which never
  // touches `leaf.view` — reaches this with a leaf whose view is no longer
  // "files". Reads everything through refs so the closure captured at mount
  // time doesn't matter; this only runs once, in the cleanup, right as the
  // component actually goes away.
  useEffect(() => {
    return () => {
      const htab = activeHtab(useStore.getState());
      const leaf = htab && findLeaf(htab.layout, sessionId);
      if (!leaf || leaf.view === "files") return;
      stateCache.delete(cacheKey);
      // A remote path only means something to that host's shell, so only `cd`
      // when the tree was browsing this very pane's own connection.
      if (remote && remote !== terminalSessionId(sessionId, leaf.sshTarget)) return;
      const path = rootRef.current;
      if (path && path !== lastKnownCwd.current) sendCommand(sessionId, `cd ${quoteForShell(path)}`);
    };
  }, [sessionId, cacheKey, remote]);

  // Tab changes go through here so the cache write is synchronous: a remount
  // from any concurrent layout change (a maximize toggle, a split)
  // re-hydrates with the tabs already as they now are.
  const commitTabs = (nextTabs: Selected[], nextActive: string | null) => {
    stateCache.set(cacheKey, { ...(stateCache.get(cacheKey) ?? emptyFileTreeState()), tabs: nextTabs, activePath: nextActive });
    setTabs(nextTabs);
    setActivePath(nextActive);
    setCloseAllArmed(false);
    if (!nextTabs.length) setTreeCollapsed(false);
  };

  // Click a file: show it beside the tree, in this pane — switching to its tab
  // if it's already open, else opening a new one right after the current.
  const selectFile = (path: string) => {
    setNarrowTree(false);
    if (tabs.some((t) => t.path === path)) {
      commitTabs(tabs, path);
      return;
    }
    const at = tabs.findIndex((t) => t.path === activePath) + 1 || tabs.length;
    commitTabs([...tabs.slice(0, at), { path, status: "loading" }, ...tabs.slice(at)], path);
  };

  // Closing the active tab moves to its right-hand neighbour (else its left).
  const closeTab = (path: string) => {
    const i = tabs.findIndex((t) => t.path === path);
    if (i < 0) return;
    const nextTabs = tabs.filter((t) => t.path !== path);
    const nextActive = path === activePath ? (nextTabs[i] ?? nextTabs[i - 1])?.path ?? null : activePath;
    markDirty(path, false);
    commitTabs(nextTabs, nextActive);
  };

  const closePreview = () => {
    if (dirtyPaths.size && !closeAllArmed) {
      setCloseAllArmed(true);
      return;
    }
    setDirtyPaths(new Set());
    commitTabs([], null);
  };

  // Actually fetch the selected file's content. Runs in whichever FileTree
  // instance is current when `selected.status` is "loading" — including a
  // FRESH instance after the maximize-triggered remount above, so even if an
  // earlier instance's in-flight request never gets to land (its result would
  // call a dead setSelected — harmless no-op, but also lost), this instance's
  // own effect independently redoes it and succeeds.
  const loadingPaths = tabs.filter((t) => t.status === "loading").map((t) => t.path).join("\0");
  useEffect(() => {
    if (!loadingPaths) return;
    let live = true;
    // Swap in a tab's result in place — only if that tab is still open, and
    // still waiting (a close and reopen meanwhile starts its own fetch).
    const land = (result: Selected) => {
      if (!live) return;
      const update = (list: Selected[]) =>
        list.map((t) => (t.path === result.path && t.status === "loading" ? result : t));
      const cached = stateCache.get(cacheKey) ?? emptyFileTreeState();
      stateCache.set(cacheKey, { ...cached, tabs: update(cached.tabs) });
      setTabs(update);
    };
    for (const path of loadingPaths.split("\0")) void readFile(path, remote).then(land);
    return () => {
      live = false;
    };
  }, [loadingPaths, cacheKey, remote]);

  // Re-read an open file in place. Unlike opening it, the tab never drops
  // back to "loading", so its editor (undo, scroll, cursor) stays mounted.
  // Unsaved edits are left alone unless `force` — checked again once the
  // read lands, in case typing started meanwhile.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const dirtyRef = useRef(dirtyPaths);
  dirtyRef.current = dirtyPaths;
  const reloadTab = useCallback((path: string, force = false) => {
    if (!force && dirtyRef.current.has(path)) return;
    void readFile(path, remote).then((result) => {
      // A background check that fails (the file mid-rewrite, say) keeps what's shown.
      if (!force && (dirtyRef.current.has(path) || result.status === "error")) return;
      const update = (list: Selected[]) =>
        list.map((t) => {
          if (t.path !== path || t.status === "loading") return t;
          // Nothing changed — keep the tab as is rather than re-render it.
          if (!force && t.status === result.status && t.content === result.content && t.mtimeMs === result.mtimeMs) return t;
          return result;
        });
      const cached = stateCache.get(cacheKey) ?? emptyFileTreeState();
      stateCache.set(cacheKey, { ...cached, tabs: update(cached.tabs) });
      setTabs(update);
    });
  }, [cacheKey, remote]);

  const toggleDir = (path: string) => {
    const opening = !expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (opening) next.add(path);
      else next.delete(path);
      return next;
    });
    if (opening && !dirs[path]) loadDir(path);
  };

  const [entryMenu, setEntryMenu] = useState<EntryMenu | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const closeEntryMenu = useCallback(() => setEntryMenu(null), []);

  const openEntryMenu = (path: string, entry: FsEntry | null, x: number, y: number) => {
    window.getSelection()?.removeAllRanges();
    setRenamingPath(null);
    setCreating(null);
    setEntryMenu({ path, entry, x, y, confirmDelete: false });
  };

  // Drop everything the tree knows under `oldPath` — or, for a rename, carry
  // the expanded folders and open file over to where they now live.
  const forgetPath = (oldPath: string, newPath: string | null) => {
    const move = (p: string) => (newPath ? newPath + p.slice(oldPath.length) : null);
    setExpanded((prev) => {
      const next = new Set<string>();
      prev.forEach((p) => {
        if (!isWithin(p, oldPath)) next.add(p);
        else if (newPath) next.add(move(p)!);
      });
      return next;
    });
    setCollapsedFrom(null);
    setDirs((d) => Object.fromEntries(Object.entries(d).filter(([p]) => !isWithin(p, oldPath))));
    // Open files under it follow a rename (reloaded at their new path), or
    // close with a delete.
    if (tabs.some((t) => isWithin(t.path, oldPath))) {
      const nextTabs = tabs.flatMap((t): Selected[] =>
        !isWithin(t.path, oldPath) ? [t] : newPath ? [{ path: move(t.path)!, status: "loading" }] : [],
      );
      tabs.forEach((t) => isWithin(t.path, oldPath) && markDirty(t.path, false));
      const nextActive =
        activePath && isWithin(activePath, oldPath)
          ? newPath
            ? move(activePath)
            : (nextTabs[Math.min(tabs.findIndex((t) => t.path === activePath), nextTabs.length - 1)]?.path ?? null)
          : activePath;
      commitTabs(nextTabs, nextActive);
    }
    if (newPath) expanded.forEach((p) => isWithin(p, oldPath) && loadDir(move(p)!));
  };

  const renameEntry = (path: string, name: string) => {
    setRenamingPath(null);
    setOpError(null);
    fsPost("rename", { path, name, session: remote })
      .then(() => {
        forgetPath(path, `${dirname(path)}/${name}`);
        loadDir(dirname(path));
      })
      .catch((e) => setOpError(`Rename failed: ${e instanceof Error ? e.message : String(e)}`));
  };

  // Draft the new entry inside the right-clicked folder (opening it so the
  // draft is visible), or at the root for the empty space.
  const startCreate = (menu: EntryMenu, kind: NewEntryKind) => {
    setEntryMenu(null);
    const dir = menu.path;
    if (dir !== root && !expanded.has(dir)) toggleDir(dir);
    setCreating({ dir, kind });
  };

  const createEntry = (dir: string, name: string, kind: NewEntryKind) => {
    setCreating(null);
    setOpError(null);
    fsPost("create", { dir, name, kind, session: remote })
      .then(() => {
        loadDir(dir);
        if (kind === "file") selectFile(`${dir}/${name}`);
      })
      .catch((e) => setOpError(`Create failed: ${e instanceof Error ? e.message : String(e)}`));
  };

  const deleteEntry = (path: string) => {
    setEntryMenu(null);
    setOpError(null);
    fsPost("delete", { path, session: remote })
      .then(() => {
        forgetPath(path, null);
        loadDir(dirname(path));
      })
      .catch((e) => setOpError(`Delete failed: ${e instanceof Error ? e.message : String(e)}`));
  };

  // Refresh re-fetches the CURRENT root (wherever it is — session-resolved or
  // manually navigated to) plus every currently-expanded subdirectory, so the
  // open shape of the tree survives — only the contents go stale-free. Unlike
  // resolveRootFromSession, this deliberately does NOT jump back to the
  // session's live cwd — that would undo a manual navigation the user is
  // just trying to refresh, not leave.
  const refresh = () => {
    if (root) loadDir(root);
    else resolveRootFromSession();
    expanded.forEach(loadDir);
    if (activePath) reloadTab(activePath);
  };

  // One button, two jobs: collapse everything (remembering what was open),
  // then flip to restoring that exact set back open again.
  const ime = useImeGuard();
  const collapsedAll = expanded.size === 0 && !!collapsedFrom;
  const toggleCollapseAll = () => {
    if (collapsedAll) {
      setExpanded(collapsedFrom!);
      setCollapsedFrom(null);
    } else if (expanded.size > 0) {
      setCollapsedFrom(expanded);
      setExpanded(new Set());
    }
  };

  const rootState = root ? dirs[root] : undefined;

  const treeUi = (
    <>
      <div className="file-tree-head">
        <input
          {...textInputProps}
          className="file-tree-path file-tree-path-input"
          {...ime.props}
          value={addressDraft}
          title={root ?? ""}
          onFocus={() => setAddressFocused(true)}
          onChange={(e) => setAddressDraft(e.target.value)}
          onBlur={() => {
            setAddressFocused(false);
            setAddressDraft(root ?? "");
          }}
          onKeyDown={(e) => {
            if (ime.handled(e)) return;
            if (e.key === "Enter") {
              const target = addressDraft.trim();
              if (target && target !== root) navigateTo(target);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setAddressDraft(root ?? "");
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {!remote && (
          <button
            className="pane-btn"
            title="Reveal in Finder"
            disabled={!root}
            onClick={() => root && void revealPath(root).then((err) => err && console.warn("[termany]", err))}
          >
            <RevealFolderIcon />
          </button>
        )}
        <button
          className="pane-btn"
          title={collapsedAll ? "Restore expanded folders" : "Collapse all"}
          disabled={expanded.size === 0 && !collapsedFrom}
          onClick={toggleCollapseAll}
        >
          {collapsedAll ? <RestoreExpandedIcon /> : <CollapseAllIcon />}
        </button>
        <button className="pane-btn" title="Refresh" onClick={refresh}>
          <RefreshIcon />
        </button>
        {narrow && tabs.length > 0 && (
          <button className="pane-btn" title="Back to open files" onClick={() => setNarrowTree(false)}>
            <FileEntryIcon />
          </button>
        )}
      </div>
      <div
        className="file-tree-list"
        onContextMenu={(e) => {
          // Rows handle (and stop) their own; this is the empty space around them.
          e.preventDefault();
          if (root && !rootError) openEntryMenu(root, null, e.clientX, e.clientY);
        }}
      >
        {rootError && <div className="file-tree-message">{rootError}</div>}
        {opError && (
          <div className="file-tree-message file-preview-error" onClick={() => setOpError(null)}>
            {opError}
          </div>
        )}
        {!rootError && root && creating?.dir === root && (
          <NewEntryRow
            kind={creating.kind}
            depth={0}
            onCreate={(name) => createEntry(root, name, creating.kind)}
            onCancel={() => setCreating(null)}
          />
        )}
        {!rootError && rootState?.status === "loaded" && rootState.entries!.length === 0 && creating?.dir !== root && (
          <div className="file-tree-message">Empty directory</div>
        )}
        {!rootError &&
          root &&
          rootState?.entries?.map((entry) => (
            <FileTreeRow
              key={entry.name}
              path={`${root}/${entry.name}`}
              entry={entry}
              depth={0}
              dirs={dirs}
              expanded={expanded}
              selectedPath={selected?.path ?? null}
              menuPath={entryMenu?.path ?? null}
              renamingPath={renamingPath}
              creating={creating}
              onToggleDir={toggleDir}
              onSelectFile={selectFile}
              onContextMenu={openEntryMenu}
              onRename={renameEntry}
              onCancelRename={() => setRenamingPath(null)}
              onCreate={createEntry}
              onCancelCreate={() => setCreating(null)}
            />
          ))}
      </div>
      {entryMenu && (
        <FileEntryMenu
          menu={entryMenu}
          onNew={(kind) => startCreate(entryMenu, kind)}
          onRename={() => {
            setRenamingPath(entryMenu.path);
            setEntryMenu(null);
          }}
          onDelete={() => setEntryMenu({ ...entryMenu, confirmDelete: true })}
          onConfirmDelete={() => deleteEntry(entryMenu.path)}
          onClose={closeEntryMenu}
        />
      )}
    </>
  );

  // Keep the file on screen current with the disk: check it whenever it's
  // shown (tab switch, the window coming back to the front) and, for a local
  // file, every couple of seconds by its modified time — a cheap stat. A
  // remote file costs a full read over SSH, so it isn't polled. Unsaved edits
  // are never overwritten by this.
  const previewShown = !!activePath && !(narrow && narrowTree);
  useEffect(() => {
    if (!previewShown || !activePath) return;
    const path = activePath;
    const check = () => {
      if (document.hidden) return;
      const tab = tabsRef.current.find((t) => t.path === path);
      if (!tab || tab.status === "loading" || dirtyRef.current.has(path)) return;
      if (remote) {
        reloadTab(path);
        return;
      }
      fetch(fsUrl("stat", { path }))
        .then((res) => (res.ok ? (res.json() as Promise<{ mtimeMs: number }>) : null))
        .then((st) => {
          const current = tabsRef.current.find((t) => t.path === path);
          if (st && current && current.status !== "loading" && st.mtimeMs !== current.mtimeMs) reloadTab(path);
        })
        .catch(() => {});
    };
    check();
    window.addEventListener("focus", check);
    const timer = remote ? undefined : window.setInterval(check, 2000);
    return () => {
      window.removeEventListener("focus", check);
      window.clearInterval(timer);
    };
  }, [previewShown, activePath, remote, reloadTab]);

  // Nothing open: just the tree, full width.
  if (!tabs.length) return <div className="file-tree">{treeUi}</div>;

  const startTreeResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const split = splitRef.current;
    if (!split) return;
    const rect = split.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const max = Math.max(220, rect.width * 0.7);
      setTreeWidth(Math.min(max, Math.max(180, ev.clientX - rect.left)));
      setTreeCollapsed(false);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // Narrow: one column, either the tree or the open files — the previews
  // stay mounted behind the tree so their edits survive the trip.
  const treeOnly = narrow && narrowTree;

  const collapsed = treeCollapsed || narrow;
  const tabStrip = (
    <FileTabStrip
      tabs={tabs}
      activePath={activePath ?? ""}
      dirtyPaths={dirtyPaths}
      onActivate={(path) => commitTabs(tabs, path)}
      onClose={closeTab}
    />
  );
  return (
    <div className={`file-tree-split ${collapsed ? "tree-collapsed" : ""} ${treeOnly ? "tree-only" : ""}`} ref={splitRef}>
      {(treeOnly || !collapsed) && (
        <>
          <div className="file-tree" style={treeOnly ? undefined : { flexBasis: treeWidth }}>{treeUi}</div>
          {!treeOnly && <div className="file-tree-resizer" onPointerDown={startTreeResize} />}
        </>
      )}
      {tabs.map((tab) => (
        <FilePreview
          key={tab.path}
          paneId={sessionId}
          selected={tab}
          visible={tab.path === selected?.path && !treeOnly}
          dirty={dirtyPaths.has(tab.path)}
          tabStrip={tabStrip}
          remote={remote}
          dark={dark}
          treeCollapsed={collapsed}
          onToggleTree={() => (narrow ? setNarrowTree(true) : setTreeCollapsed((v) => !v))}
          onDirtyChange={markDirty}
          onReload={(force) => reloadTab(tab.path, force)}
          onClose={closePreview}
          closeArmed={closeAllArmed}
        />
      ))}
    </div>
  );
}
