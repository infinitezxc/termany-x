import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronIcon } from "./icons";

export type RangeChoice<P extends string> = { preset: P } | { preset: null; since: string; until: string };

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parse(date: string): Date {
  return new Date(`${date}T00:00:00`);
}

/** Gap kept between the popover and the edges of its pane. */
const EDGE = 8;
/** Below this much pane width the presets stack above the calendar. */
const SIDE_BY_SIDE_MIN = 380;

/**
 * Date-range control for the usage pane: one pill (styled like UsageSelect)
 * whose popover lists the preset ranges as quick picks beside a month
 * calendar. In the calendar the first click sets the start, the second the
 * end (either order); hovering previews the span. Weeks start on Monday to
 * match the "This week" preset. Dates are local YYYY-MM-DD strings.
 *
 * The popover is placed against the enclosing pane (`.usage-pane`, which
 * clips), not the viewport, so it stays whole in a narrow split.
 */
export function UsageRangePicker<P extends string>({
  preset,
  since,
  until,
  presets,
  min,
  max,
  locale,
  hints,
  onChange,
}: {
  preset: P | null;
  since: string;
  until: string;
  presets: Array<{ key: P; label: string }>;
  min: string;
  max: string;
  locale: string;
  hints: { start: string; end: string; prevMonth: string; nextMonth: string };
  onChange: (choice: RangeChoice<P>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState(() => parse(until));
  const [place, setPlace] = useState<{
    left: number;
    top: number;
    maxWidth: number;
    maxHeight: number;
    stacked: boolean;
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /** `refocus` returns focus to the trigger — the focused item is about to unmount. */
  const close = (refocus = false) => {
    setOpen(false);
    setPending(null);
    setHover(null);
    setPlace(null);
    if (refocus) triggerRef.current?.focus();
  };

  // Fit the popover into the pane, which clips. Stack it when the pane is
  // narrow. Horizontally: right-aligned to the trigger, then shifted so
  // neither edge is clipped. Vertically: just below the trigger, shifted up
  // (over the trigger if need be) when that would run past the pane's bottom,
  // and capped to the pane's height so the rest scrolls inside it.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const anchor = ref.current;
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!anchor || !trigger || !menu) return;
      const pane = (trigger.closest(".usage-pane") ?? document.documentElement).getBoundingClientRect();
      const a = anchor.getBoundingClientRect();
      const t = trigger.getBoundingClientRect();
      const stacked = pane.width < SIDE_BY_SIDE_MIN;
      const maxWidth = Math.max(0, pane.width - EDGE * 2);
      const maxHeight = Math.max(0, pane.height - EDGE * 2);
      const width = Math.min(menu.scrollWidth, maxWidth);
      // Border-box height: scrollHeight is content + padding, add the border.
      const natural = menu.scrollHeight + (menu.offsetHeight - menu.clientHeight);
      const height = Math.min(natural, maxHeight);
      let left = Math.min(t.right - width, pane.right - EDGE - width);
      left = Math.max(left, pane.left + EDGE);
      let top = Math.min(t.bottom + 4, pane.bottom - EDGE - height);
      top = Math.max(top, pane.top + EDGE);
      const next = { left: left - a.left, top: top - a.top, maxWidth, maxHeight, stacked };
      setPlace((p) =>
        p &&
        p.left === next.left &&
        p.top === next.top &&
        p.maxWidth === next.maxWidth &&
        p.maxHeight === next.maxHeight &&
        p.stacked === next.stacked
          ? p
          : next
      );
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = new ResizeObserver(measure);
    const pane = triggerRef.current?.closest(".usage-pane");
    if (pane) ro.observe(pane);
    // Its own size changes too: 5- vs 6-week months, stacking.
    if (menuRef.current) ro.observe(menuRef.current);
    return () => {
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, [open, place?.stacked]);

  useEffect(() => {
    if (!open) return;
    // Clicking elsewhere moves focus there itself; don't pull it back.
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    // Capture on `window` so Escape closes just the popover, before any
    // modal's own Escape handler closes the whole overlay (see UsageSelect).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(!!ref.current?.contains(document.activeElement));
      }
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const fmt = useMemo(() => {
    const thisYear = new Date().getFullYear();
    const short = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
    const long = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" });
    return (date: string) => {
      const d = parse(date);
      return (d.getFullYear() === thisYear ? short : long).format(d);
    };
  }, [locale]);

  const fmtFull = useMemo(() => {
    const f = new Intl.DateTimeFormat(locale, { dateStyle: "full" });
    return (date: string) => f.format(parse(date));
  }, [locale]);

  const monthTitle = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(view),
    [locale, view]
  );

  const weekdays = useMemo(() => {
    const f = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(2024, 0, 1 + i))); // 2024-01-01 is a Monday
  }, [locale]);

  // Leading nulls pad the first row out to Monday.
  const cells = useMemo(() => {
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const count = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const out: Array<string | null> = Array((first.getDay() + 6) % 7).fill(null);
    for (let d = 1; d <= count; d++) out.push(ymd(new Date(view.getFullYear(), view.getMonth(), d)));
    return out;
  }, [view]);

  const monthKey = (d: Date) => d.getFullYear() * 12 + d.getMonth();
  const canPrev = monthKey(view) > monthKey(parse(min));
  const canNext = monthKey(view) < monthKey(parse(max));
  const shiftMonth = (by: number) => setView((v) => new Date(v.getFullYear(), v.getMonth() + by, 1));

  // While picking, highlight pending..hover; otherwise the current range.
  let lo = since;
  let hi = until;
  if (pending) {
    const other = hover ?? pending;
    [lo, hi] = pending <= other ? [pending, other] : [other, pending];
  }

  const pickDay = (date: string) => {
    if (!pending) {
      setPending(date);
      return;
    }
    const [a, b] = pending <= date ? [pending, date] : [date, pending];
    onChange({ preset: null, since: a, until: b });
    close(true);
  };

  const label =
    preset !== null
      ? presets.find((p) => p.key === preset)?.label ?? preset
      : since === until
        ? fmt(since)
        : `${fmt(since)} – ${fmt(until)}`;

  return (
    <div className="usage-select usage-range" ref={ref}>
      <button
        ref={triggerRef}
        className={`usage-select-btn ${open ? "open" : ""}`}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close();
          else {
            setView(parse(until));
            setOpen(true);
          }
        }}
      >
        <span className="usage-select-label">{label}</span>
        <ChevronIcon dir="down" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="dialog"
          aria-label={label}
          className={`usage-select-menu usage-range-menu ${place?.stacked ? "stacked" : ""}`}
          // Hidden for the first layout pass, until it has been measured and placed.
          style={
            place
              ? {
                  left: place.left,
                  top: place.top,
                  right: "auto",
                  maxWidth: place.maxWidth,
                  maxHeight: place.maxHeight,
                }
              : { visibility: "hidden" }
          }
        >
          <div className="usage-range-presets">
            {presets.map((p) => (
              <button
                key={p.key}
                className={`usage-select-item ${p.key === preset ? "active" : ""}`}
                onClick={() => {
                  onChange({ preset: p.key });
                  close(true);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="usage-cal">
            <div className="usage-cal-head">
              <button
                className="usage-cal-nav"
                disabled={!canPrev}
                aria-label={hints.prevMonth}
                title={hints.prevMonth}
                onClick={() => shiftMonth(-1)}
              >
                <ChevronIcon dir="left" />
              </button>
              <span className="usage-cal-title">{monthTitle}</span>
              <button
                className="usage-cal-nav"
                disabled={!canNext}
                aria-label={hints.nextMonth}
                title={hints.nextMonth}
                onClick={() => shiftMonth(1)}
              >
                <ChevronIcon dir="right" />
              </button>
            </div>
            <div className="usage-cal-grid" onMouseLeave={() => setHover(null)}>
              {weekdays.map((w, i) => (
                <span key={`w${i}`} className="usage-cal-weekday">
                  {w}
                </span>
              ))}
              {cells.map((date, i) => {
                if (!date) return <span key={`b${i}`} />;
                const disabled = date < min || date > max;
                const inRange = date >= lo && date <= hi;
                const edge = date === lo || date === hi;
                return (
                  <button
                    key={date}
                    className={[
                      "usage-cal-day",
                      inRange ? "in-range" : "",
                      edge ? "edge" : "",
                      date === max ? "today" : "",
                    ].join(" ")}
                    disabled={disabled}
                    title={date}
                    aria-label={fmtFull(date)}
                    aria-pressed={inRange}
                    onMouseEnter={() => pending && setHover(date)}
                    onClick={() => pickDay(date)}
                  >
                    {Number(date.slice(8))}
                  </button>
                );
              })}
            </div>
            <div className="usage-cal-hint" aria-live="polite">{pending ? hints.end : hints.start}</div>
          </div>
        </div>
      )}
    </div>
  );
}
