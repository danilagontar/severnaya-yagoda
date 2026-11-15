import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ListFilter, Moon, Sun, X } from "lucide-react";
import { HIT, INVOICES, cn, plural } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import rawData from "@/data/case.json";
import { extractByRules } from "@/core/extract";
import { summarize, type Extractor } from "@/core/reconcile";
import { computeState, describeEvent, makeEvent, metrics, metricsDelta, orderTimeline, validateDecision, type AppEvent, type Decision, type Metrics } from "@/core/events";
import { Scenarios } from "@/components/Scenarios";
import type { Scenario } from "@/data/scenarios";
import type { CaseData, Extracted, Letter, Verdict } from "@/core/types";
import { extractWithLlm, getLlmStatus, type LlmMode } from "@/llm/provider";
import { Queue, DEFAULT_FILTER, type QueueFilter } from "@/components/Queue";
import { DocCard, forgetDrafts } from "@/components/DocCard";
import { Registry } from "@/components/Registry";
import { EtalonView } from "@/components/EtalonView";
import { NewLetter } from "@/components/NewLetter";
import { LlmUsage } from "@/components/LlmUsage";
import { VERDICT, fmtRub } from "@/components/verdict";
import { Sep } from "@/components/sep";

const data = rawData as CaseData;
// Срез данных кейса: всё, что происходит в пилоте (письма, приёмка, решения), идёт после него.
const SNAP = (() => {
  const m = data.meta.snapshot.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) : new Date();
})();
type View = "queue" | "registry" | "scenarios" | "etalon";

const load = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const save = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* хранилище недоступно: работаем без него */
  }
};

export default function App() {
  // Журнал событий: письма, решения бухгалтера, передача реестра (src/core/events.ts).
  // Раньше новые письма лежали в sy.extra: переносим их в журнал один раз.
  const [events, setEvents] = useState<AppEvent[]>(() => load<AppEvent[] | null>("sy.events", null) ?? load<Letter[]>("sy.extra", []).map((letter) => makeEvent({ type: "letter", letter })));
  // разбор ИИ сохраняется: иначе после перезагрузки письма, где поля нашёл только ИИ, разберутся одними правилами и сменят вердикт
  const [llmCache, setLlmCache] = useState<Record<string, Extracted>>(() => load("sy.llm", {}));
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>("queue");
  // сортировка, направления и «скрыть решённые» сохраняются между перезагрузками
  const [filter, setFilter] = useState<QueueFilter>(() => {
    const v = load<Partial<QueueFilter>>("sy.view", {});
    return { ...DEFAULT_FILTER, sort: v.sort ?? DEFAULT_FILTER.sort, dirs: { ...DEFAULT_FILTER.dirs, ...(v.dirs ?? {}) }, hideDone: v.hideDone ?? false };
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(load<string[]>("sy.collapsed", ["none"])));
  // открытые бухгалтером документы: пометка «новое» с них снимается
  const [seen, setSeen] = useState<Set<string>>(() => new Set(load<string[]>("sy.seen", [])));
  const markSeen = (id: string) => setSeen((s) => (s.has(id) ? s : new Set([...s, id])));
  useEffect(() => save("sy.seen", [...seen]), [seen]);
  const [dark, setDark] = useState<boolean>(() => load("sy.dark", false));
  const [llm, setLlm] = useState<{ mode: LlmMode; model: string | null }>({ mode: "rules", model: null });
  // баннер после события: что произошло и у каких документов сменился вердикт
  const [changes, setChanges] = useState<{ label: string; items: { id: string; from: Verdict; to: Verdict }[] } | null>(null);
  // метки разницы на плитках сводки после последнего события
  const [delta, setDelta] = useState<Partial<Metrics> | null>(null);
  const deltaTimer = useRef<number | undefined>(undefined);
  const [flash, setFlash] = useState(0);
  // направление подсветки плиток: живёт до следующего события, чтобы цвет догас, даже когда цифры уже скрыты
  const [flashDelta, setFlashDelta] = useState<Partial<Metrics> | null>(null);
  const [tick, setTick] = useState(0);
  const [mobileQueue, setMobileQueue] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getLlmStatus().then(setLlm);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    save("sy.dark", dark);
  }, [dark]);
  useEffect(() => save("sy.events", events), [events]);
  useEffect(() => save("sy.llm", llmCache), [llmCache]);
  useEffect(() => save("sy.collapsed", [...collapsed]), [collapsed]);
  useEffect(() => save("sy.view", { sort: filter.sort, dirs: filter.dirs, hideDone: filter.hideDone }), [filter.sort, filter.dirs, filter.hideDone]);

  const extractor = useMemo(() => (t: string, s: string) => llmCache[s + "\n" + t] ?? extractByRules(t, s), [llmCache]);
  const state = useMemo(() => computeState(data, events, extractor), [events, extractor]);
  const { results, statuses, registry } = state;
  const extra = useMemo(() => events.flatMap((e) => (e.type === "letter" ? [e.letter] : [])), [events]);
  const summary = useMemo(() => summarize(results), [results]);
  const current = results.find((r) => r.id === selected) ?? null;
  const nextId = `Н-${String(extra.length + 1).padStart(2, "0")}`;

  useEffect(() => {
    if (!selected && results.length) {
      const first = results.find((r) => r.verdict === "stop") ?? results[0];
      setSelected(first.id);
    }
  }, [results, selected]);

  // Прокрутка: у каждой вкладки своя позиция. Первый заход: сверху, потом: где остановились.
  // На компьютере прокручивается <main>, на узком экране: вся страница.
  const scrollPos = useRef<Partial<Record<View, number>>>({});
  const viewRef = useRef<View>(view);
  const scroller = () => (window.matchMedia("(min-width: 768px)").matches ? mainRef.current : null);
  const readScroll = () => scroller()?.scrollTop ?? window.scrollY;
  const writeScroll = (top: number) => {
    const el = scroller();
    if (el) el.scrollTop = top;
    else window.scrollTo({ top });
  };
  useEffect(() => {
    const onScroll = () => (scrollPos.current[viewRef.current] = readScroll());
    const el = mainRef.current;
    el?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  useLayoutEffect(() => {
    viewRef.current = view;
    writeScroll(scrollPos.current[view] ?? 0);
  }, [view]);

  const select = (id: string) => {
    if (selected && selected !== id) markSeen(selected); // «новое» снимается, когда уходят к другому документу
    setSelected(id);
    scrollPos.current.queue = 0; // новый документ открывается сверху
    if (view === "queue") writeScroll(0);
    setView("queue");
  };

  const addLetter = async (sender: string, text: string) => {
    const id = nextId;
    const at = clock();
    const letter: Letter = { id, received: `${String(at.getDate()).padStart(2, "0")}.${String(at.getMonth() + 1).padStart(2, "0")} ${at.toTimeString().slice(0, 5)}`, sender: sender || "", text };
    let cache = llmCache;
    if (llm.mode === "gigachat") {
      const { ex } = await extractWithLlm(text, sender, "ИИ");
      cache = { ...llmCache, [sender + "\n" + text]: ex };
      setLlmCache(cache);
      setTick((t) => t + 1);
    }
    apply([...events, makeEvent({ type: "letter", letter }, at)], { label: `Пришло письмо ${id}`, ex: (t, s) => cache[s + "\n" + t] ?? extractByRules(t, s) });
    setSelected(id); // открылось само: «новое» остаётся, пока бухгалтер не нажмёт на него или не уйдёт к другому документу
    setView("queue");
  };

  const resetExtra = () => {
    const removed = new Set(extra.map((l) => l.sender + "\n" + l.text));
    setLlmCache((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !removed.has(k))));
    // номера Н-01… выдаются заново: черновики убранных писем не должны достаться новым
    const removedIds = new Set(extra.map((l) => l.id));
    forgetDrafts((id) => removedIds.has(id));
    setSeen((s) => new Set([...s].filter((id) => !removedIds.has(id))));
    // вместе с письмами уходят решения и подтверждения полей по ним: номера Н-01… выдаются заново
    apply(events.filter((e) => e.type !== "letter" && !("doc" in e && removedIds.has(e.doc))), { label: "Новые письма убраны из очереди" });
    setSelected(null);
  };

  // «Требует решения»: стоп / вернуть / вопрос без действующего решения бухгалтера
  const open = results.filter((r) => (r.verdict === "stop" || r.verdict === "return" || r.verdict === "ask") && !statuses.get(r.id)?.valid);
  const needDecision = open.length;
  const openBy = (v: string) => open.filter((r) => r.verdict === v).length;
  // «Разобрано»: документы, по которым бухгалтер принимает решение (дубли и письма-контекст решения не требуют)
  const decidable = results.filter((r) => r.verdict !== "duplicate" && r.verdict !== "letter");
  const decided = decidable.filter((r) => statuses.get(r.id)?.resolved).length;
  const waitingCount = decidable.filter((r) => statuses.get(r.id)?.waiting).length;

  const toQueue = () => {
    setFilter({ ...DEFAULT_FILTER, sort: filter.sort, dirs: filter.dirs, hideDone: filter.hideDone, verdicts: ["stop", "return", "ask"] });
    setCollapsed(new Set([...collapsed].filter((g) => g !== "decide")));
    setView("queue");
    if (!window.matchMedia("(min-width: 768px)").matches) setMobileQueue(true);
  };

  /**
   * Применить новый журнал: пересчитать, показать разницу показателей на плитках и (с label) баннер
   * с документами, у которых сменился вердикт.
   */
  const apply = (next: AppEvent[], opts: { label?: string; ex?: Extractor } = {}) => {
    const after = computeState(data, next, opts.ex ?? extractor);
    const d = metricsDelta(metrics(state), metrics(after));
    window.clearTimeout(deltaTimer.current);
    setDelta(Object.keys(d).length ? d : null);
    setFlash((n) => n + 1);
    setFlashDelta(d);
    deltaTimer.current = window.setTimeout(() => setDelta(null), 4000); // цифры разницы 4 с, цвет плитки гаснет 6 с (index.css)
    if (opts.label) {
      const before = new Map(results.map((r) => [r.id, r.verdict]));
      setChanges({ label: opts.label, items: after.results.filter((r) => before.has(r.id) && before.get(r.id) !== r.verdict).map((r) => ({ id: r.id, from: before.get(r.id)!, to: r.verdict })) });
    }
    setEvents(next);
  };
  /**
   * Часы кейса: события не могут случиться раньше среза данных (16.11 12:00), иначе в журнале и истории
   * они окажутся раньше писем кейса. Пока реальное время раньше среза, каждое событие идёт через минуту после предыдущего.
   */
  const clock = () => {
    const now = new Date();
    return now > SNAP ? now : new Date(SNAP.getTime() + (events.length + 1) * 60_000);
  };
  const push = (e: AppEvent) => apply([...events, e]);
  // казначей оплатил утверждённый реестр (в продукте: по банковской выписке)
  const payRegistry = () =>
    apply([...events, makeEvent({ type: "registry-paid", items: registry.items.map((i) => ({ id: i.r.id, amount: i.amount })), total: registry.total }, clock())], { label: "Реестр оплачен казначеем" });
  const undoLast = () => events.length && apply(events.slice(0, -1), { label: `Отменено: ${describeEvent(events[events.length - 1])}` });
  const removeEvent = (id: string) => {
    const e = events.find((x) => x.id === id);
    if (e) apply(events.filter((x) => x.id !== id), { label: `Убрано из журнала: ${describeEvent(e)}` });
  };
  const resetAll = () => {
    forgetDrafts((id) => id.startsWith("Н-"));
    setSeen(new Set());
    apply([], { label: "Демо сброшено: исходные 25 документов" });
    setSelected(null);
  };
  const runScenario = (sc: Scenario) => apply([...events, makeEvent(sc.event, clock())], { label: sc.title });
  const timeline = useMemo(() => (current?.orderId ? orderTimeline(data, events, results, current.orderId) : []), [current?.orderId, events, results]);
  /** Решение бухгалтера (null: вернуть в работу). Возвращает текст ошибки, если решение не подходит. */
  const decide = (r: (typeof results)[number], d: Decision | null): string | null => {
    if (!d) {
      push(makeEvent({ type: "reopen", doc: r.id }, clock()));
      return null;
    }
    const err = validateDecision(r, d);
    if (!err) push(makeEvent({ type: "decision", doc: r.id, decision: d }, clock()));
    return err;
  };

  const queuePanel = (
    <>
      <Queue
        results={results}
        selected={view === "queue" ? selected : null}
        onSelect={(id) => {
          select(id);
          setMobileQueue(false);
        }}
        statuses={statuses}
        seen={seen}
        filter={filter}
        setFilter={setFilter}
        collapsed={collapsed}
        toggleGroup={(id) => {
          const n = new Set(collapsed);
          if (n.has(id)) n.delete(id);
          else n.add(id);
          setCollapsed(n);
        }}
      />
      {extra.length > 0 && (
        <div className="border-t border-line px-4 py-2 text-[12px] text-muted-foreground">
          Новых писем: {extra.length}
          <button onClick={resetExtra} className="ml-2 underline underline-offset-2 hover:text-ink">
            убрать из очереди
          </button>
        </div>
      )}
    </>
  );

  // short: подпись на телефоне и планшете (до 1024 px), чтобы вкладки и кнопки шапки помещались в ширину экрана
  const NAV: { id: View; label: string; short: string }[] = [
    { id: "queue", label: "Очередь", short: "Очередь" },
    { id: "registry", label: "Реестр", short: "Реестр" },
    { id: "scenarios", label: "Проверить пилот", short: "Проверить" },
    { id: "etalon", label: "Сверить с эталоном", short: "Эталон" },
  ];


  // плитки итогов: порядок по тому, с чего бухгалтер начинает день
  const counts = (["stop", "return", "ask"] as const).filter((v) => openBy(v) > 0);
  const needTile: Tile = {
    id: "need",
    label: "Требует решения",
    value: String(needDecision),
    suffix: `из ${decidable.length}`,
    tone: needDecision ? "ask" : "pay",
    sub: (
      <>
        {counts.map((v, i) => (
          <span key={v} className={v === "stop" ? "text-stop" : "text-ask"}>
            {i > 0 && <Sep />}
            {VERDICT_SHORT[v]} {openBy(v)}
          </span>
        ))}
        {waitingCount > 0 && (
          <span className="text-muted-foreground">
            {counts.length > 0 && <Sep />}ждём ответа {waitingCount}
          </span>
        )}
        {!counts.length && !waitingCount && <span className="text-pay">всё решено</span>}
      </>
    ),
    progress: decidable.length ? (decidable.length - needDecision) / decidable.length : 1,
    link: { label: "в очередь", onClick: toQueue },
    detail: `Документы со стопом, возвратом или вопросом без решения бухгалтера. Всего решений требуют ${decidable.length} документов (дубли и письма не в счёт), разобрано ${decided}.`,
    delta: delta?.need,
    flash: flashDelta?.need,
    polarity: -1,
  };
  const tiles: Tile[] = [
    needTile,
    {
      id: "pay",
      label: "К оплате",
      hint: `${registry.proposed.count} ${plural(registry.proposed.count, INVOICES)}`,
      value: fmtRub(registry.proposed.total),
      sub: <span className={registry.total ? "text-pay" : "text-muted-foreground"}>в реестре {fmtRub(registry.total)}</span>,
      progress: registry.proposed.total ? Math.min(1, registry.total / registry.proposed.total) : 0,
      link: { label: "реестр", onClick: () => setView("registry") },
      detail: `Сверка предлагает к оплате ${num(registry.proposed.total)} ₽. В реестре ${num(registry.total)} ₽ (${registry.items.length} ${plural(registry.items.length, INVOICES)}): туда попадают только счета, подтверждённые бухгалтером.`,
      // цифра разницы стоит у крупной суммы, поэтому считается по ней; плитка подсвечивается и при подтверждении в реестр
      delta: delta?.proposed,
      flash: flashDelta?.proposed ?? flashDelta?.registry,
      polarity: 1,
    },
    {
      id: "deferred",
      label: "Отложено",
      value: fmtRub(summary.deferred + summary.held),
      sub: (
        <>
          ждём склад {num(summary.deferred)}
          {summary.held > 0 && (
            <>
              <Sep />
              ждём реквизиты {num(summary.held)}
            </>
          )}
        </>
      ),
      detail: `Эти деньги заплатят позже, это не экономия.\nДо приёмки на складе или ответа закупщика: ${num(summary.deferred)} ₽.${summary.held > 0 ? `\nСверка пройдена, но поставщик просит сменить реквизиты (П-2): ${num(summary.held)} ₽.` : ""}`,
      delta: delta?.deferred,
      flash: flashDelta?.deferred,
      polarity: 0,
    },
    {
      id: "prevented",
      label: "Не платить",
      value: fmtRub(summary.preventedTotal),
      sub: <span className="text-muted-foreground">дубли, подмена, цены, итог</span>,
      detail: `Дубли ${num(summary.prevented.duplicate)} ₽\nПодмена получателя ${num(summary.prevented.fraud)} ₽\nЦены без согласования ${num(summary.prevented.price)} ₽\nОшибка в итоге ${num(summary.prevented.arithmetic)} ₽`,
      delta: delta?.prevented,
      flash: flashDelta?.prevented,
      polarity: 0,
    },
  ];

  return (
    <div className="flex min-h-full flex-col md:h-full">
      {/* Рейка */}
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-6 gap-y-1 bg-rail px-5 py-2 text-rail-fg md:h-14 md:flex-nowrap md:py-0">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-7" />
          <div className="leading-tight">
            <p className="text-[14px] font-semibold">Северная ягода</p>
            <p className="hidden text-[11.5px] text-rail-muted sm:block">Проверка счетов поставщиков</p>
          </div>
        </div>
        <nav aria-label="Разделы" className="order-last flex h-10 w-full items-stretch overflow-x-auto md:order-none md:h-full md:w-auto md:overflow-visible">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              aria-current={view === n.id ? "page" : undefined}
              className={cn(
                "relative flex-1 px-2 text-[13.5px] whitespace-nowrap transition-colors sm:flex-none sm:px-3.5",
                view === n.id
                  ? "bg-white/10 font-semibold text-white after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:bg-rail-active"
                  : "text-rail-muted hover:bg-white/5 hover:text-rail-fg",
              )}
            >
              <span className="lg:hidden">{n.short}</span>
              <span className="hidden lg:inline">{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-[12px] text-rail-muted xl:inline">Срез {data.meta.snapshot}</span>
          <LlmUsage mode={llm.mode} model={llm.model} tick={tick} />
          <button
            onClick={() => setDark(!dark)}
            className="grid size-8 place-items-center rounded-md text-rail-muted hover:bg-white/10 hover:text-rail-fg"
            aria-label={dark ? "Светлая тема" : "Тёмная тема"}
            title={dark ? "Светлая тема" : "Тёмная тема"}
          >
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </header>

      {/* Итоги очереди */}
      {/* Сетка: у плиток одного ряда общая строка подписей и общая строка сумм: всё на одном уровне, даже если подпись переносится */}
      {/* Итоги: на компьютере четыре плитки, на телефоне главная плитка и список из трёх строк */}
      <section aria-label="Итоги очереди" className="shrink-0 border-b border-line bg-surface">
        {/* на планшете 2×2: четыре в ряд там не помещаются и подписи обрезаются */}
        <div className="hidden md:grid md:grid-cols-2 lg:grid-cols-[1fr_1fr_1.2fr_1fr]">
          {tiles.map((t) => (
            <Stat key={`${t.id}-${flash}`} {...t} />
          ))}
        </div>
        <div className="md:hidden">
          <Stat key={`m-${needTile.id}-${flash}`} {...needTile} />
          <ul className="border-t border-line px-4 py-1.5">
            {tiles.slice(1).map((t) => (
              <StatRow key={`m-${t.id}-${flash}`} {...t} />
            ))}
          </ul>
        </div>
      </section>

      <div className="flex flex-1 md:min-h-0">
        <aside className="my-3 ml-3 hidden w-[360px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface-2 md:flex">{queuePanel}</aside>

        {/* Узкий экран: та же очередь (поиск, фильтры, группы) на весь экран */}
        {mobileQueue && (
          <div role="dialog" aria-modal="true" aria-label="Очередь документов" className="fixed inset-0 z-40 flex flex-col bg-surface-2 md:hidden">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-line bg-surface px-4">
              <span className="text-[15px] font-semibold text-ink">Очередь</span>
              <button onClick={() => setMobileQueue(false)} className="grid size-8 place-items-center rounded-md hover:bg-surface-2" aria-label="Закрыть очередь">
                <X className="size-4" />
              </button>
            </div>
            {queuePanel}
          </div>
        )}

        <main ref={mainRef} className="min-w-0 flex-1 md:overflow-y-auto">
          {changes && (
            <div role="status" className="sticky top-3 z-20 mx-3 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-hl px-4 py-2 text-[13px] text-ink">
              <span className="font-medium">{changes.label}.</span>
              {changes.items.length === 0 ? (
                <span className="text-muted-foreground">Вердикты документов не изменились.</span>
              ) : (
                changes.items.map((c) => (
                  <button key={c.id} onClick={() => select(c.id)} className="underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
                    {c.id}: {VERDICT[c.from].label.toLowerCase()} → {VERDICT[c.to].label.toLowerCase()}
                  </button>
                ))
              )}
              {events.length > 0 && (
                <button onClick={undoLast} className="ml-auto text-[12.5px] underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
                  отменить последнее
                </button>
              )}
              <button onClick={() => setChanges(null)} className={cn("grid size-6 place-items-center rounded hover:bg-black/5", !events.length && "ml-auto")} aria-label="Скрыть">
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {view === "queue" && (
            <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-[13px] md:hidden">
              <button onClick={() => setMobileQueue(true)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-surface px-2.5 font-medium text-ink">
                <ListFilter className="size-3.5" aria-hidden />
                Очередь
                <span className="num text-muted-foreground">{results.length}</span>
              </button>
              {current && (
                <span className="min-w-0 truncate text-muted-foreground">
                  <span className="num font-medium text-ink">{current.id}</span><Sep />{current.supplier ?? current.ex.senderName ?? ""}
                </span>
              )}
            </div>
          )}
          {view === "queue" && current && (
            <DocCard
              key={current.id}
              r={current}
              all={results}
              onSelect={select}
              status={statuses.get(current.id)!}
              onDecide={(d) => decide(current, d)}
              timeline={timeline}
              llm={llm.mode}
              onConfirmField={(field, value, source) => push(makeEvent({ type: "field-confirmed", doc: current.id, field, value, source }, clock()))}
              onCrossCheck={async (r) => {
                const { ex } = await extractWithLlm(r.text, r.sender, "ИИ");
                setLlmCache((c) => ({ ...c, [r.sender + "\n" + r.text]: ex }));
                setTick((t) => t + 1);
              }}
            />
          )}
          {view === "registry" && <Registry
              results={results}
              statuses={statuses}
              registry={registry}
              onSelect={select}
              snapshot={data.meta.snapshot}
              onSubmit={() => push(makeEvent({ type: "registry-submitted", ids: registry.items.map((i) => i.r.id), total: registry.total }, clock()))}
              onApprove={() => push(makeEvent({ type: "registry-approved" }, clock()))}
              onPay={payRegistry}
            />}
          {view === "scenarios" && (
            <Scenarios
              form={<NewLetter onSubmit={addLetter} llm={llm.mode} nextId={nextId} />}
              events={events}
              preview={(body) => {
                const after = computeState(data, [...events, makeEvent(body)], extractor);
                return after.results.filter((r) => results.find((x) => x.id === r.id)?.verdict !== r.verdict).map((r) => ({ id: r.id, from: results.find((x) => x.id === r.id)!.verdict, to: r.verdict }));
              }}
              onRun={runScenario}
              onLetter={addLetter}
              onUndo={undoLast}
              onRemove={removeEvent}
              onReset={resetAll}
              onSelect={select}
            />
          )}
          {view === "etalon" && <EtalonView data={data} onSelect={select} />}
        </main>
      </div>
    </div>
  );
}

const num = (n: number) => n.toLocaleString("ru-RU");

const VERDICT_SHORT = { stop: "стоп", return: "вернуть", ask: "вопрос" } as const;

type Tile = {
  id: string;
  label: string;
  hint?: string; // уточнение в строке названия
  value: string;
  suffix?: string; // мелко после значения: «из 18»
  sub?: React.ReactNode; // строка под значением: разбивка
  progress?: number; // 0..1, полоска под плиткой
  detail?: string; // всплывающая подсказка
  tone?: "pay" | "ask";
  link?: { label: string; onClick: () => void };
  delta?: number; // изменение после последнего события (цифра, скрывается через 4 с)
  flash?: number; // изменение для подсветки плитки (живёт до следующего события)
  polarity?: 1 | -1 | 0; // 1: рост это хорошо, −1: рост это плохо, 0: без оценки
};

// цвет по смыслу: стало лучше: зелёный, хуже: красный, без оценки: жёлтый
const meaning = (polarity: Tile["polarity"], v?: number) => (!v ? null : !polarity ? "neutral" : Math.sign(v) * polarity > 0 ? "good" : "bad");
const flashClass = (m: string | null) => (m === "good" ? "tile-up" : m === "bad" ? "tile-down" : m === "neutral" ? "tile-neutral" : "");

function DeltaChip({ delta, polarity }: { delta?: number; polarity?: Tile["polarity"] }) {
  if (!delta) return null;
  const m = meaning(polarity, delta);
  return (
    <span className={cn("num shrink-0 rounded-[4px] px-1.5 text-[12px] font-semibold", m === "good" ? "bg-pay/15 text-pay" : m === "bad" ? "bg-stop/12 text-stop" : "bg-hl text-ink")} aria-label={`изменение ${delta > 0 ? "плюс" : "минус"} ${num(Math.abs(delta))}`}>
      {delta > 0 ? "+" : "−"}
      {num(Math.abs(delta))}
    </span>
  );
}

function TileLink({ link }: { link: NonNullable<Tile["link"]> }) {
  return (
    <button onClick={link.onClick} className={HIT + " inline-flex shrink-0 items-center gap-0.5 text-[12px] font-medium text-accent underline decoration-accent/35 underline-offset-[3px] hover:decoration-accent"}>
      {link.label}
      <ArrowRight className="size-3" aria-hidden />
    </button>
  );
}

/** Плитка итогов: название и ссылка, значение, разбивка, полоска прогресса. На телефоне главная плитка во всю ширину, разбивка справа от значения. */
function Stat({ label, hint, value, suffix, sub, progress, detail, tone, link, delta, flash, polarity = 0 }: Tile) {
  return (
    <div className={cn("flex min-w-0 flex-col border-line px-4 py-2 md:odd:border-r md:[&:nth-child(-n+2)]:border-b lg:border-r lg:last:border-r-0 lg:[&:nth-child(-n+2)]:border-b-0", flashClass(meaning(polarity, flash)))} title={detail}>
      <span className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="truncate text-[12px] leading-tight text-muted-foreground">
          {label}
          {hint && <span className="num"><Sep />{hint}</span>}
        </span>
        {link && <TileLink link={link} />}
      </span>
      <span className="mt-0.5 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 md:flex-col md:items-start md:justify-start">
        <span className="flex items-baseline gap-2">
          <span className={cn("num shrink-0 text-[18px] font-semibold leading-tight tracking-[-0.01em]", tone === "pay" ? "text-pay" : tone === "ask" ? "text-ask" : "text-ink")}>{value}</span>
          {suffix && <span className="num text-[12px] text-muted-foreground">{suffix}</span>}
          <DeltaChip delta={delta} polarity={polarity} />
        </span>
        {sub && <span className="num min-w-0 truncate text-[11.5px] leading-tight text-muted-foreground md:mt-0.5 md:max-w-full">{sub}</span>}
      </span>
      {progress !== undefined && (
        <span className="mt-1.5 h-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label={`${label}: готово ${Math.round(progress * 100)} %`}>
          <span className="block h-full rounded-full bg-pay transition-[width] duration-500" style={{ width: `${progress * 100}%` }} />
        </span>
      )}
    </div>
  );
}

/** Строка итогов на телефоне: название слева, значение справа; подробности во всплывающей подсказке и в разделах. */
function StatRow({ label, hint, value, sub, detail, link, delta, flash, polarity = 0 }: Tile) {
  // суммы стоят ровной колонкой справа; уточнение у строки со ссылкой идёт слева, после названия.
  // строка со ссылкой на подложке, как кнопка; подложка выступает на 8 px, содержимое не сдвигается
  const body = (
    <>
      <span className="flex min-w-0 items-baseline truncate text-[12.5px] text-muted-foreground">
        {label}
        {/* строка flex: пробел в начале элемента схлопывается, поэтому отступ полем */}
        {hint && <span className="num ml-[0.3em]">{hint}</span>}
        {link && sub && (
          <span className="num truncate text-[11.5px]">
            <Sep />
            {sub}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-baseline gap-2">
        <DeltaChip delta={delta} polarity={polarity} />
        <span className="num text-[14px] font-semibold text-ink">{value}</span>
      </span>
    </>
  );
  const cls = cn("flex w-full items-baseline justify-between gap-3 py-1 text-left", flashClass(meaning(polarity, flash)));
  return (
    <li title={detail}>
      {link ? (
        <button onClick={link.onClick} className={cn(cls, "-mx-2 my-0.5 w-[calc(100%+1rem)] rounded-md border border-line bg-surface-2 px-[7px] hover:border-line-strong active:bg-muted")} aria-label={`${label}: ${value}, открыть ${link.label}`}>
          {body}
        </button>
      ) : (
        <span className={cls}>{body}</span>
      )}
    </li>
  );
}
