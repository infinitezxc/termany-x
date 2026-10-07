import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import { useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { textInputProps } from "../textInputProps";
import {
  ArrowIcon,
  ChevronIcon,
  CloseIcon,
  MatchCaseIcon,
  RegexIcon,
  ReplaceAllIcon,
  ReplaceIcon,
  WholeWordIcon,
} from "./icons";

/** Counting stops here — past it the widget just says "1000+". */
const MATCH_LIMIT = 1000;

/**
 * CodeMirror's search panel, VS Code style: a small widget floating at the
 * editor's top right — one line for find, with an arrow on the left that
 * folds out a second line for replace. Plugged in through `search({
 * createPanel })`, so the search state, commands and keymap (⌘G, F3, Esc)
 * all stay CodeMirror's own; this only draws it.
 */
export function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  const root = createRoot(dom);
  const render = () => root.render(<FindWidget view={view} state={view.state} />);
  return {
    dom,
    top: true,
    mount() {
      // Rendered synchronously so the field exists to focus right away, the
      // way CodeMirror's own panel selects its field when it opens.
      flushSync(render);
      const field = dom.querySelector<HTMLInputElement>("[main-field]");
      field?.focus();
      field?.select();
    },
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))
      ) {
        render();
      }
    },
    // The editor is torn down from a React effect cleanup; unmounting another
    // root synchronously in the middle of that is not allowed.
    destroy: () => queueMicrotask(() => root.unmount()),
  };
}

function countMatches(state: EditorState, query: SearchQuery): number[] | null {
  if (!query.valid) return null;
  const starts: number[] = [];
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done && starts.length <= MATCH_LIMIT; next = cursor.next()) {
    starts.push(next.value.from);
  }
  return starts;
}

function FindWidget({ view, state }: { view: EditorView; state: EditorState }) {
  const query = getSearchQuery(state);
  const readOnly = state.readOnly;
  const [replaceOpen, setReplaceOpen] = useState(false);
  const matches = useMemo(() => countMatches(state, query), [state.doc, query]);

  const setQuery = (change: Partial<ConstructorParameters<typeof SearchQuery>[0]>) => {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: query.search,
          replace: query.replace,
          caseSensitive: query.caseSensitive,
          regexp: query.regexp,
          wholeWord: query.wholeWord,
          ...change,
        }),
      ),
    });
  };

  let count = "";
  if (query.search && matches) {
    if (!matches.length) count = "No results";
    else if (matches.length > MATCH_LIMIT) count = `${MATCH_LIMIT}+`;
    else {
      const sel = state.selection.main;
      const at = matches.indexOf(sel.from);
      count = `${at >= 0 && !sel.empty ? at + 1 : "?"} of ${matches.length}`;
    }
  }
  const miss = !!query.search && (!query.valid || matches?.length === 0);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, field: "find" | "replace") => {
    if (e.nativeEvent.isComposing) return;
    // ⌘G, F3, Esc: the same keys as in the editor itself.
    if (runScopeHandlers(view, e.nativeEvent, "search-panel")) {
      e.preventDefault();
      return;
    }
    // ⌥C / ⌥W / ⌥R toggle the options, as in VS Code.
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const toggle = { KeyC: "caseSensitive", KeyW: "wholeWord", KeyR: "regexp" }[e.code] as
        | "caseSensitive"
        | "wholeWord"
        | "regexp"
        | undefined;
      if (toggle) {
        e.preventDefault();
        setQuery({ [toggle]: !query[toggle] });
        return;
      }
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (field === "find") (e.shiftKey ? findPrevious : findNext)(view);
    // ⌘⌥⏎ as in VS Code — plain ⌘⏎ is the app's "new child page".
    else if ((e.metaKey || e.ctrlKey) && e.altKey) replaceAll(view);
    else replaceNext(view);
  };

  const option = (key: "caseSensitive" | "wholeWord" | "regexp", title: string, icon: JSX.Element) => (
    <button
      className={`cm-find-opt ${query[key] ? "on" : ""}`}
      title={title}
      aria-pressed={query[key]}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setQuery({ [key]: !query[key] })}
    >
      {icon}
    </button>
  );

  return (
    <div className="cm-find-widget">
      {!readOnly && (
        <button
          className="cm-find-expand"
          title={replaceOpen ? "Hide replace" : "Show replace"}
          aria-expanded={replaceOpen}
          onClick={() => setReplaceOpen((v) => !v)}
        >
          <ChevronIcon dir={replaceOpen ? "down" : "right"} />
        </button>
      )}
      <div className="cm-find-rows">
        <div className="cm-find-row">
          <div className={`cm-find-field ${miss ? "miss" : ""}`}>
            <input
              {...textInputProps}
              {...{ "main-field": "true" }}
              placeholder="Find"
              value={query.search}
              onChange={(e) => setQuery({ search: e.target.value })}
              onKeyDown={(e) => onKeyDown(e, "find")}
            />
            {option("caseSensitive", "Match case (⌥C)", <MatchCaseIcon />)}
            {option("wholeWord", "Match whole word (⌥W)", <WholeWordIcon />)}
            {option("regexp", "Use regular expression (⌥R)", <RegexIcon />)}
          </div>
          <span className={`cm-find-count ${miss ? "miss" : ""}`}>{count}</span>
          <button className="find-bar-btn" title="Previous match (⇧⏎)" onClick={() => findPrevious(view)}>
            <ArrowIcon dir="up" />
          </button>
          <button className="find-bar-btn" title="Next match (⏎)" onClick={() => findNext(view)}>
            <ArrowIcon dir="down" />
          </button>
          <button className="find-bar-btn" title="Close (esc)" onClick={() => closeSearchPanel(view)}>
            <CloseIcon />
          </button>
        </div>
        {replaceOpen && !readOnly && (
          <div className="cm-find-row">
            <div className="cm-find-field">
              <input
                {...textInputProps}
                placeholder="Replace"
                value={query.replace}
                onChange={(e) => setQuery({ replace: e.target.value })}
                onKeyDown={(e) => onKeyDown(e, "replace")}
              />
            </div>
            <button className="find-bar-btn" title="Replace (⏎)" onClick={() => replaceNext(view)}>
              <ReplaceIcon />
            </button>
            <button className="find-bar-btn" title="Replace all (⌘⌥⏎)" onClick={() => replaceAll(view)}>
              <ReplaceAllIcon />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
