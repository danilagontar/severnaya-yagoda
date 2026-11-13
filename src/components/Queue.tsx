import { useEffect, useRef, useState } from "react";
import { Archive, ArrowDown, ArrowUp, Check, ChevronDown, CircleAlert, CircleCheck, EyeOff, Search, SlidersHorizontal, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Addressee, Result, Verdict } from "@/core/types";
import { VERDICT, VerdictIcon, fmtRub } from "./verdict";
import { Sep } from "@/components/sep";

export type SortKey = "urgency" | "amount" | "date" | "order";
export type SortDir = "default" | "reverse";
export interface QueueFilter {
  q: string;
  verdicts: Verdict[]; // ставится ссылкой «в очередь» из полосы итогов
  sort: SortKey;
  dirs: Record<SortKey, SortDir>; // направление запоминается у каждой сортировки отдельно
  hideDone: boolean;
  to: string[]; // адресаты вопроса
  reasons: string[]; // причины
  onlyNew: boolean;
}
export const DEFAULT_FILTER: QueueFilter = { q: "", verdicts: [], sort: "urgency", dirs: { urgency: "default", amount: "default", date: "default", order: "default" }, hideDone: false, to: [], reasons: [], onlyNew: false };

// ---------- «Кому» и «Причина»: вопросы, которые бухгалтер задаёт себе в работе ----------

const ROLE_LABEL: Record<Addressee["role"], string> = {
  buyer: "",
  supplier: "Поставщики",
  warehouse: "Склад",
  treasurer: "Казначей",
  cfo: "Финансовый директор",
  procurement: "Отдел закупок",
};
export const addresseeKey = (a: Addressee) => (a.role === "buyer" ? a.name : ROLE_LABEL[a.role]);

export const REASONS: { id: string; label: string }[] = [
  { id: "price", label: "Цена без согласования" },
  { id: "accept", label: "Не принято складом" },
  { id: "over", label: "Принято или выставлено сверх заказа" },
  { id: "requisites", label: "Реквизиты и поставщик" },
  { id: "dup", label: "Дубли и копии" },
  { id: "total", label: "Ошибка в итоге" },
  { id: "binding", label: "Заказ или материал не найден" },
  { id: "parse", label: "Разборы правил и ИИ расходятся" },
];
export function reasonsOf(r: Result): string[] {
  const out = new Set<string>();
  if (r.verdict === "duplicate") out.add("dup");
  for (const f of r.findings) {
    if (f.level === "info" || f.level === "ok") continue;
    if (f.rule === "П-6" && /сверх|Склад принял/.test(f.text)) out.add("over");
    else if (f.rule === "П-6") out.add("price");
    if (f.rule === "П-4" || f.rule === "П-5") out.add("accept");
    if (f.rule === "П-3") out.add("over");
    if (f.rule === "П-2") out.add("requisites");
    if (f.rule === "П-8") out.add("total");
    if (f.rule === "П-1" || f.rule === "П-7") out.add("binding");
    if (f.rule === "Разбор") out.add("parse");
  }
  return [...out];
}

// Цвет заголовка группы — тот же, что у вердиктов (docs/palette.md): заливка 12 % поверх фона колонки.
const GROUP_STYLE: Record<string, { icon: LucideIcon; color: string }> = {
  decide: { icon: CircleAlert, color: "var(--v-ask)" },
  pay: { icon: CircleCheck, color: "var(--v-pay)" },
  none: { icon: Archive, color: "var(--v-dup)" },
};

export const GROUPS: { id: string; title: string; verdicts: Verdict[] }[] = [
  { id: "decide", title: "Требует решения", verdicts: ["stop", "return", "ask"] },
  { id: "pay", title: "К оплате", verdicts: ["pay"] },
  { id: "none", title: "Без действий", verdicts: ["duplicate", "letter"] },
];
const ORDER: Verdict[] = ["stop", "return", "ask", "pay", "duplicate", "letter"];
const RANK = Object.fromEntries(ORDER.map((v, i) => [v, i])) as Record<Verdict, number>;
// Повторное нажатие на выбранную сортировку разворачивает порядок; short — подпись на кнопке «Вид»
const SHORT: Record<SortKey, [string, string]> = {
  urgency: ["Срочные", "Несрочные"],
  amount: ["Крупные", "Мелкие"],
  date: ["Новые", "Старые"],
  order: ["ЗП-01→14", "ЗП-14→01"],
};
const SORTS: { id: SortKey; label: [string, string] }[] = [
  { id: "urgency", label: ["Сначала срочные", "Сначала несрочные"] },
  { id: "amount", label: ["Сначала крупные суммы", "Сначала мелкие суммы"] },
  { id: "date", label: ["Сначала новые", "Сначала старые"] },
  { id: "order", label: ["Заказы по порядку", "Заказы в обратном порядке"] },
];

function receivedKey(r: Result) {
  const m = r.received.match(/(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})/);
  return m ? `${m[2]}${m[1]}${m[3]}${m[4]}` : "";
}

const ROLE_ORDER = (k: string) => (Object.values(ROLE_LABEL).includes(k) ? 1 : 0); // сначала закупщики по именам, потом службы

export function Queue({
  results,
  selected,
  onSelect,
  done,
  filter,
  setFilter,
  collapsed,
  toggleGroup,
}: {
  results: Result[];
  selected: string | null;
  onSelect: (id: string) => void;
  done: Set<string>;
  filter: QueueFilter;
  setFilter: (f: QueueFilter) => void;
  collapsed: Set<string>;
  toggleGroup: (id: string) => void;
}) {
  const q = filter.q.trim().toLowerCase();
  // поиск по сумме: «40000», «40 000», «40 000 ₽»
  const qNum = /^\d[\d\s\u00a0]*([.,]\d+)?\s*₽?$/.test(q) ? Number(q.replace(/[\s\u00a0₽]/g, "").replace(",", ".")) : null;
  const amountHit = (r: Result) => qNum !== null && qNum > 0 && [r.invoiced, r.due, r.payNow].some((x) => x !== null && x !== undefined && Math.abs(x - qNum) < 0.005);
  const list = results.filter(
    (r) =>
      (!filter.verdicts.length || filter.verdicts.includes(r.verdict)) &&
      (!filter.hideDone || !done.has(r.id)) &&
      (!filter.onlyNew || r.isNew) &&
      (!filter.to.length || r.addressees.some((a) => filter.to.includes(addresseeKey(a)))) &&
      (!filter.reasons.length || reasonsOf(r).some((x) => filter.reasons.includes(x))) &&
      (!q || amountHit(r) || [r.id, r.supplier, r.ex.senderName, r.ex.invoiceNo, r.orderId].some((x) => x?.toLowerCase().includes(q))),
  );
  const cmp = (a: Result, b: Result) => (filter.dirs[filter.sort] === "reverse" ? -1 : 1) * cmpDefault(a, b);
  const cmpDefault = (a: Result, b: Result) => {
    switch (filter.sort) {
      case "amount":
        return (b.invoiced ?? -1) - (a.invoiced ?? -1);
      case "date":
        return receivedKey(b).localeCompare(receivedKey(a));
      case "order": // счета одного заказа рядом; без заказа — в конце; внутри заказа — по дате
        return (a.orderId ?? "ЗП-99").localeCompare(b.orderId ?? "ЗП-99") || receivedKey(a).localeCompare(receivedKey(b));
      default:
        return RANK[a.verdict] - RANK[b.verdict] || Number(b.isNew) - Number(a.isNew);
    }
  };
  // счётчики для меню фильтров — по всей очереди
  const toCounts = new Map<string, number>();
  for (const r of results) for (const k of new Set(r.addressees.map(addresseeKey))) toCounts.set(k, (toCounts.get(k) ?? 0) + 1);
  const toOptions = [...toCounts.entries()]
    .sort((a, b) => Number(ROLE_ORDER(a[0])) - Number(ROLE_ORDER(b[0])) || b[1] - a[1])
    .map(([id, n]) => ({ id, label: id, count: n }));
  const reasonOptions = REASONS.map((x) => ({ ...x, count: results.filter((r) => reasonsOf(r).includes(x.id)).length }));
  const newCount = results.filter((r) => r.isNew).length;
  const verdictGroup = GROUPS.find((g) => g.verdicts.length === filter.verdicts.length && g.verdicts.every((v) => filter.verdicts.includes(v)));
  const anyFilter = filter.to.length || filter.reasons.length || filter.onlyNew || filter.verdicts.length || filter.q;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Панель инструментов очереди: поиск, сортировка, «скрыть решённые»; под ней срезы по группам */}
      <div className="flex flex-col gap-2 border-b border-line px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Поиск по очереди</span>
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              value={filter.q}
              onChange={(e) => setFilter({ ...filter, q: e.target.value })}
              placeholder="Поставщик, счёт, сумма"
              className="h-8 w-full rounded-md border border-input bg-surface pr-7 pl-8 text-[13px] text-ink placeholder:text-muted-foreground"
            />
            {filter.q && (
              <button onClick={() => setFilter({ ...filter, q: "" })} className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-surface-2 hover:text-ink" aria-label="Очистить поиск">
                <X className="size-3.5" />
              </button>
            )}
          </label>
          <ViewMenu filter={filter} setFilter={setFilter} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterMenu label="Кому" options={toOptions} value={filter.to} onChange={(to) => setFilter({ ...filter, to })} />
          <FilterMenu label="Причина" options={reasonOptions} value={filter.reasons} onChange={(reasons) => setFilter({ ...filter, reasons })} />
          <button
            onClick={() => setFilter({ ...filter, onlyNew: !filter.onlyNew })}
            aria-pressed={filter.onlyNew}
            disabled={!newCount && !filter.onlyNew}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12.5px] transition-colors disabled:opacity-40",
              filter.onlyNew ? "border-ink bg-ink text-surface" : "border-input bg-surface text-ink hover:bg-surface-2",
            )}
          >
            Новые <span className={cn("num", filter.onlyNew ? "text-surface/70" : "text-muted-foreground")}>{newCount}</span>
          </button>
          {verdictGroup && (
            <span className="inline-flex h-7 items-center gap-1 rounded-md bg-ink pr-1 pl-2 text-[12.5px] text-surface">
              {verdictGroup.title}
              <button onClick={() => setFilter({ ...filter, verdicts: [] })} className="grid size-5 place-items-center rounded hover:bg-white/15" aria-label="Убрать фильтр">
                <X className="size-3" />
              </button>
            </span>
          )}
          {anyFilter ? (
            <button
              onClick={() => setFilter({ ...DEFAULT_FILTER, sort: filter.sort, dirs: filter.dirs, hideDone: filter.hideDone })}
              className="ml-auto inline-flex items-center gap-0.5 text-[12.5px] text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
            >
              <X className="size-3" aria-hidden />
              сбросить
            </button>
          ) : null}
        </div>
      </div>

      <nav aria-label="Очередь документов" className="min-h-0 flex-1 overflow-y-auto">
        {GROUPS.map((g) => {
          const items = list.filter((r) => g.verdicts.includes(r.verdict)).sort(cmp);
          if (!items.length) return null;
          const isCollapsed = collapsed.has(g.id) && !anyFilter; // при поиске и фильтрах группы раскрыты
          const sum = items.reduce((s, r) => s + (r.verdict === "pay" ? r.payNow : r.ex.kind === "letter" ? 0 : r.invoiced ?? 0), 0);
          return (
            <section key={g.id}>
              <h2
                className="sticky top-0 z-10 border-b border-[color-mix(in_srgb,var(--g)_28%,var(--border))] bg-[color-mix(in_srgb,var(--g)_12%,var(--surface-2))]"
                style={{ ["--g" as string]: GROUP_STYLE[g.id].color }}
              >
                <button
                  onClick={() => toggleGroup(g.id)}
                  aria-expanded={!isCollapsed}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] font-semibold text-ink"
                >
                  {(() => {
                    const GI = GROUP_STYLE[g.id].icon;
                    return <GI className="size-4 text-[var(--g)]" strokeWidth={2.2} aria-hidden />;
                  })()}
                  <span>{g.title}</span>
                  <span className="num rounded-full bg-surface px-1.5 text-[12px] font-medium text-ink ring-1 ring-line">{items.length}</span>
                  {g.id !== "none" && <span className="num ml-auto font-semibold">{fmtRub(sum)}</span>}
                  <ChevronDown className={cn("size-4 text-muted-foreground transition-transform duration-200", g.id === "none" && "ml-auto", isCollapsed && "-rotate-90")} aria-hidden />
                </button>
              </h2>
              {!isCollapsed && (
                <ul className="border-b border-line">
                  {items.map((r) => {
                    const amount = r.verdict === "pay" ? r.payNow : r.invoiced;
                    const isSel = r.id === selected;
                    return (
                      <li key={r.id}>
                        <button
                          onClick={() => onSelect(r.id)}
                          aria-current={isSel ? "true" : undefined}
                          className={cn(
                            "grid w-full grid-cols-[18px_1fr_auto] items-start gap-x-2.5 px-4 py-2.5 text-left transition-colors",
                            isSel ? "bg-surface ring-1 ring-line-strong ring-inset" : "hover:bg-surface/70",
                          )}
                        >
                          <span className="mt-[1px] grid size-[18px] place-items-center" title={VERDICT[r.verdict].label}>
                            <VerdictIcon v={r.verdict} className="size-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="flex items-baseline gap-2">
                              <span className="num text-[12px] font-semibold text-muted-foreground">{r.id}</span>
                              <span className="truncate font-medium text-ink">{r.supplier ?? r.ex.senderName ?? "Отправитель не указан"}</span>
                              {r.isNew && <span className="rounded-[3px] bg-cta px-1 text-[10px] font-semibold uppercase leading-4 text-white">новое</span>}
                            </span>
                            <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">{r.headline}</span>
                          </span>
                          <span className="flex flex-col items-end gap-1 pl-1">
                            <span className={cn("num text-[13px] font-medium whitespace-nowrap", r.verdict === "duplicate" ? "text-muted-foreground line-through decoration-1" : "text-ink")}>
                              {amount !== null && amount !== undefined && r.ex.kind !== "letter" ? fmtRub(amount) : ""}
                            </span>
                            {done.has(r.id) && (
                              <span className="inline-flex items-center gap-0.5 text-[11px] text-pay">
                                <Check className="size-3" strokeWidth={2.5} aria-hidden />
                                решено
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
        {!list.length && <p className="px-4 py-6 text-muted-foreground">Ничего не найдено. Измените фильтр или поиск.</p>}
      </nav>
    </div>
  );
}


function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  return { open, setOpen, ref };
}
const POPOVER = "absolute top-9 z-30 rounded-[8px] border border-line bg-surface p-1.5 text-[13px] shadow-[0_8px_24px_rgba(16,18,24,0.18)]";

/** Кнопка «Вид»: сортировка (повторное нажатие разворачивает порядок) и «Скрыть решённые». */
function ViewMenu({ filter, setFilter }: { filter: QueueFilter; setFilter: (f: QueueFilter) => void }) {
  const { open, setOpen, ref } = usePopover();
  const rev = filter.dirs[filter.sort] === "reverse";
  const Dir = rev ? ArrowUp : ArrowDown;
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="true"
        className={cn(
          "relative inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] transition-colors",
          open ? "border-ink text-ink" : "border-input bg-surface text-ink hover:bg-surface-2",
        )}
        title="Сортировка и вид"
      >
        <SlidersHorizontal className="size-3.5 shrink-0" aria-hidden />
        {/* текущая сортировка видна, даже когда меню закрыто */}
        <span key={filter.sort + rev} className="anim-swap">{SHORT[filter.sort][rev ? 1 : 0]}</span>
        <Dir className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {filter.hideDone && <EyeOff className="size-3.5 shrink-0 text-muted-foreground" aria-label="решённые скрыты" />}
      </button>
      {open && (
        <div role="menu" className={cn(POPOVER, "right-0 w-[250px]")}>
          <p className="px-2 pt-1 pb-1 text-[11.5px] font-medium text-muted-foreground">Сортировка<Sep />повторное нажатие разворачивает</p>
          {SORTS.map((o) => {
            const on = filter.sort === o.id;
            const itemRev = filter.dirs[o.id] === "reverse";
            return (
              <button
                key={o.id}
                role="menuitemradio"
                aria-checked={on}
                onClick={() => setFilter({ ...filter, sort: o.id, dirs: on ? { ...filter.dirs, [o.id]: itemRev ? "default" : "reverse" } : filter.dirs })}
                className={cn("flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left hover:bg-surface-2", on ? "font-medium text-ink" : "text-ink")}
              >
                <Check className={cn("size-3.5 shrink-0", on ? "opacity-100" : "opacity-0")} aria-hidden />
                <span key={String(itemRev)} className="anim-swap flex-1">{o.label[itemRev ? 1 : 0]}</span>
                <ArrowDown
                  className={cn("size-3.5 text-muted-foreground transition-transform duration-300 ease-out", itemRev && "rotate-180", !on && "opacity-0")}
                  aria-label={on ? "нажмите ещё раз, чтобы развернуть" : undefined}
                />
              </button>
            );
          })}
          <div className="my-1 border-t border-line" />
          <label className="flex cursor-pointer items-center gap-2 rounded-[5px] px-2 py-1.5 text-ink hover:bg-surface-2">
            <input type="checkbox" checked={filter.hideDone} onChange={(e) => setFilter({ ...filter, hideDone: e.target.checked })} className="size-3.5 accent-[var(--accent)]" />
            Скрыть решённые
          </label>
        </div>
      )}
    </div>
  );
}

/** Выпадающий фильтр с галочками и числом документов у каждого пункта. */
function FilterMenu({ label, options, value, onChange }: { label: string; options: { id: string; label: string; count: number }[]; value: string[]; onChange: (v: string[]) => void }) {
  const { open, setOpen, ref } = usePopover();
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="true"
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12.5px] transition-colors",
          value.length ? "border-ink bg-ink text-surface" : "border-input bg-surface text-ink hover:bg-surface-2",
        )}
      >
        {label}
        {value.length > 0 && <span className="num text-surface/70">| {value.length}</span>}
        <ChevronDown className="size-3.5 opacity-70" aria-hidden />
      </button>
      {open && (
        <div role="menu" className={cn(POPOVER, "left-0 w-[260px]")}>
          {options.map((o) => (
            <label
              key={o.id}
              className={cn("flex cursor-pointer items-center gap-2 rounded-[5px] px-2 py-1.5 text-ink hover:bg-surface-2", !o.count && !value.includes(o.id) && "pointer-events-none opacity-40")}
            >
              <input type="checkbox" checked={value.includes(o.id)} onChange={() => toggle(o.id)} className="size-3.5 accent-[var(--accent)]" />
              <span className="flex-1">{o.label}</span>
              <span className="num text-[12px] text-muted-foreground">{o.count}</span>
            </label>
          ))}
          {value.length > 0 && (
            <>
              <div className="my-1 border-t border-line" />
              <button onClick={() => onChange([])} className="w-full rounded-[5px] px-2 py-1.5 text-left text-muted-foreground hover:bg-surface-2 hover:text-ink">
                Снять выбор
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
