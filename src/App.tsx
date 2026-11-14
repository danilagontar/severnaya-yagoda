import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ListFilter, Moon, Plus, Sun, X } from "lucide-react";
import { INVOICES, cn, plural } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import rawData from "@/data/case.json";
import { extractByRules } from "@/core/extract";
import { reconcileAll, summarize, type Extractor } from "@/core/reconcile";
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
  const [dark, setDark] = useState<boolean>(() => load("sy.dark", false));
  const [llm, setLlm] = useState<{ mode: LlmMode; model: string | null }>({ mode: "rules", model: null });
  // баннер после события: что произошло и у каких документов сменился вердикт
  const [changes, setChanges] = useState<{ label: string; items: { id: string; from: Verdict; to: Verdict }[] } | null>(null);
  // метки разницы на плитках сводки после последнего события
  const [delta, setDelta] = useState<Partial<Metrics> | null>(null);
  const deltaTimer = useRef<number | undefined>(undefined);
  const [flash, setFlash] = useState(0);
  // «Новое письмо» в шапке: переход во вкладку «Сценарии» к форме письма
  const [letterFocus, setLetterFocus] = useState(false);
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
  const base = useMemo(() => reconcileAll(data), []);
  const summary = useMemo(() => summarize(results), [results]);
  const baseSummary = useMemo(() => summarize(base), [base]);
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
    setSelected(id);
    setView("queue");
  };

  const resetExtra = () => {
    const removed = new Set(extra.map((l) => l.sender + "\n" + l.text));
    setLlmCache((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !removed.has(k))));
    // номера Н-01… выдаются заново: черновики убранных писем не должны достаться новым
    const removedIds = new Set(extra.map((l) => l.id));
    forgetDrafts((id) => removedIds.has(id));
    // убираем только письма; решения по ним без документа ни на что не влияют
    apply(events.filter((e) => e.type !== "letter"), { label: "Новые письма убраны из очереди" });
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
  const undoLast = () => events.length && apply(events.slice(0, -1), { label: `Отменено: ${describeEvent(events[events.length - 1])}` });
  const removeEvent = (id: string) => {
    const e = events.find((x) => x.id === id);
    if (e) apply(events.filter((x) => x.id !== id), { label: `Убрано из журнала: ${describeEvent(e)}` });
  };
  const resetAll = () => {
    forgetDrafts((id) => id.startsWith("Н-"));
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
    { id: "scenarios", label: "Сценарии", short: "Сценарии" },
    { id: "etalon", label: "Проверка на эталоне", short: "Эталон" },
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
          <Button
            size="sm"
            onClick={() => {
              setView("scenarios");
              setLetterFocus(true);
            }}
          >
            <Plus />
            Новое письмо
          </Button>
        </div>
      </header>

      {/* Итоги очереди */}
      {/* Сетка: у плиток одного ряда общая строка подписей и общая строка сумм: всё на одном уровне, даже если подпись переносится */}
      <section aria-label="Итоги очереди" className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(150px,1fr))] border-b border-line bg-surface">
        <Stat
          key={`reg-${flash}`}
          label="В реестре"
          hint={`${registry.items.length} ${plural(registry.items.length, INVOICES)}`}
          value={fmtRub(registry.total)}
          tone="pay"
          link={{ label: "реестр", onClick: () => setView("registry") }}
          extra={`из ${fmtRub(registry.proposed.total)}`}
          delta={delta?.registry} flash={flashDelta?.registry} polarity={1}
          detail={`Сверка предлагает к оплате ${num(registry.proposed.total)} ₽ (${registry.proposed.count} ${plural(registry.proposed.count, INVOICES)}). В реестр попадают только счета, подтверждённые бухгалтером.`}
        />
        <Stat
          key={`prev-${flash}`}
          label="Не платить"
          hint="дубли, подмена, цены, итог"
          value={fmtRub(summary.preventedTotal)}
          delta={delta?.prevented} flash={flashDelta?.prevented} polarity={0}
          detail={`Дубли ${num(summary.prevented.duplicate)} ₽
Подмена получателя ${num(summary.prevented.fraud)} ₽
Цены без согласования ${num(summary.prevented.price)} ₽
Ошибка в итоге ${num(summary.prevented.arithmetic)} ₽`}
        />
        <Stat
          key={`def-${flash}`}
          label="Отложено"
          hint="не экономия"
          value={fmtRub(summary.deferred)}
          delta={delta?.deferred} flash={flashDelta?.deferred} polarity={0}
          extra={summary.held > 0 ? `+ задержано ${fmtRub(summary.held)}` : undefined}
          detail={`До приёмки на складе или ответа закупщика. Эти деньги заплатят позже, это не экономия.${summary.held > 0 ? `\nОтдельно задержано ${num(summary.held)} ₽: сверка пройдена, но поставщику пишут о смене реквизитов (П-2).` : ""}`}
        />
        <Stat
          key={`need-${flash}`}
          label="Требует решения"
          hint={`стоп ${openBy("stop")} | вернуть ${openBy("return")} | вопрос ${openBy("ask")}`}
          value={String(needDecision)}
          delta={delta?.need} flash={flashDelta?.need} polarity={-1}
          tone="ask"
          link={{
            label: "в очередь",
            onClick: () => {
              setFilter({ ...DEFAULT_FILTER, sort: filter.sort, dirs: filter.dirs, hideDone: filter.hideDone, verdicts: ["stop", "return", "ask"] });
              setCollapsed(new Set([...collapsed].filter((g) => g !== "decide")));
              setView("queue");
              if (!window.matchMedia("(min-width: 768px)").matches) setMobileQueue(true);
            },
          }}
        />
        <Stat key={`dec-${flash}`} label="Разобрано" hint={waitingCount ? `ждём ответа ${waitingCount}` : `в ящике ${summary.total}`} value={`${decided} из ${decidable.length}`} delta={delta?.decided} flash={flashDelta?.decided} polarity={1} />
      </section>

      <div className="flex flex-1 md:min-h-0">
        <aside className="hidden w-[360px] shrink-0 flex-col border-r border-line bg-surface-2 md:flex">{queuePanel}</aside>

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
            <div role="status" className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-hl px-5 py-2 text-[13px] text-ink">
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
            />}
          {view === "scenarios" && (
            <Scenarios
              form={<NewLetter onSubmit={addLetter} llm={llm.mode} nextId={nextId} focus={letterFocus} onFocused={() => setLetterFocus(false)} />}
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
          {view === "etalon" && <EtalonView base={base} summary={baseSummary} onSelect={select} />}
        </main>
      </div>
    </div>
  );
}

const num = (n: number) => n.toLocaleString("ru-RU");

function Stat({
  label,
  hint,
  value,
  detail,
  tone,
  link,
  extra,
  delta,
  flash,
  polarity = 0,
}: {
  label: string;
  hint?: string;
  value: string;
  detail?: string;
  tone?: "pay" | "ask";
  link?: { label: string; onClick: () => void };
  extra?: string;
  delta?: number; // изменение после последнего события (цифра, скрывается через 4 с)
  flash?: number; // изменение для подсветки плитки (живёт до следующего события)
  polarity?: 1 | -1 | 0; // 1: рост это хорошо, −1: рост это плохо, 0: без оценки
}) {
  // цвет по смыслу: стало лучше: зелёный, хуже: красный, без оценки: жёлтый
  const meaning = (v?: number) => (!v ? null : polarity === 0 ? "neutral" : Math.sign(v) * polarity > 0 ? "good" : "bad");
  const flashTone = meaning(flash);
  const chipTone = meaning(delta);
  return (
    <div className={cn("row-span-2 grid min-w-0 grid-rows-subgrid border-r border-b border-line px-4 py-2 last:border-r-0 md:border-b-0", flashTone === "good" && "tile-up", flashTone === "bad" && "tile-down", flashTone === "neutral" && "tile-neutral")} title={detail}>
      <span className="line-clamp-2 self-start text-[12px] leading-tight text-muted-foreground">
        {label}
        {hint && <span className="num"><Sep />{hint}</span>}
      </span>
      <span className="mt-0.5 flex min-w-0 items-baseline gap-2">
        <span className={cn("num shrink-0 text-[18px] font-semibold leading-tight tracking-[-0.01em]", tone === "pay" ? "text-pay" : tone === "ask" ? "text-ask" : "text-ink")}>{value}</span>
        {delta ? (
          <span className={cn("num shrink-0 rounded-[4px] px-1.5 text-[12px] font-semibold", chipTone === "good" ? "bg-pay/15 text-pay" : chipTone === "bad" ? "bg-stop/12 text-stop" : "bg-hl text-ink")} aria-label={`изменение ${delta > 0 ? "плюс" : "минус"} ${num(Math.abs(delta))}`}>
            {delta > 0 ? "+" : "−"}
            {num(Math.abs(delta))}
          </span>
        ) : null}
        {link && (
          <button onClick={link.onClick} className="inline-flex items-center gap-0.5 text-[12px] font-medium text-accent underline decoration-accent/35 underline-offset-[3px] hover:decoration-accent">
            {link.label}
            <ArrowRight className="size-3" aria-hidden />
          </button>
        )}
        {/* в одной строке с суммой, чтобы суммы во всех плитках стояли на одном уровне; полный текст в подсказке плитки */}
        {extra && <span className="num min-w-0 truncate text-[11.5px] text-muted-foreground">{extra}</span>}
      </span>
    </div>
  );
}
