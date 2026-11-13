import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ListFilter, Moon, Plus, Sun, X } from "lucide-react";
import { INVOICES, cn, plural } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import rawData from "@/data/case.json";
import { extractByRules } from "@/core/extract";
import { reconcileAll, summarize } from "@/core/reconcile";
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
type View = "queue" | "registry" | "etalon" | "new";

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
    /* хранилище недоступно — работаем без него */
  }
};

export default function App() {
  const [extra, setExtra] = useState<Letter[]>(() => load("sy.extra", []));
  // разбор ИИ сохраняется: иначе после перезагрузки письма, где поля нашёл только ИИ, разберутся одними правилами и сменят вердикт
  const [llmCache, setLlmCache] = useState<Record<string, Extracted>>(() => load("sy.llm", {}));
  const [done, setDone] = useState<Set<string>>(() => new Set(load<string[]>("sy.done", [])));
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
  const [changes, setChanges] = useState<{ id: string; from: Verdict; to: Verdict }[] | null>(null);
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
  useEffect(() => save("sy.extra", extra), [extra]);
  useEffect(() => save("sy.llm", llmCache), [llmCache]);
  useEffect(() => save("sy.done", [...done]), [done]);
  useEffect(() => save("sy.collapsed", [...collapsed]), [collapsed]);
  useEffect(() => save("sy.view", { sort: filter.sort, dirs: filter.dirs, hideDone: filter.hideDone }), [filter.sort, filter.dirs, filter.hideDone]);

  const newIds = useMemo(() => new Set(extra.map((l) => l.id)), [extra]);
  const results = useMemo(
    () => reconcileAll(data, [...data.letters, ...extra], (t, s) => llmCache[s + "\n" + t] ?? extractByRules(t, s), newIds),
    [extra, llmCache, newIds],
  );
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

  // Прокрутка: у каждой вкладки своя позиция. Первый заход — сверху, потом — где остановились.
  // На компьютере прокручивается <main>, на узком экране — вся страница.
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
    // Новое письмо не может прийти раньше среза данных: иначе в сортировке «Сначала новые» оно окажется ниже старых.
    const now = new Date();
    const snap = data.meta.snapshot.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
    const snapAt = snap ? new Date(+snap[3], +snap[2] - 1, +snap[1], +snap[4], +snap[5]) : now;
    const at = now > snapAt ? now : new Date(snapAt.getTime() + (extra.length + 1) * 60_000);
    const letter: Letter = { id, received: `${String(at.getDate()).padStart(2, "0")}.${String(at.getMonth() + 1).padStart(2, "0")} ${at.toTimeString().slice(0, 5)}`, sender: sender || "", text };
    let cache = llmCache;
    if (llm.mode === "gigachat") {
      const { ex } = await extractWithLlm(text, sender, "ИИ");
      cache = { ...llmCache, [sender + "\n" + text]: ex };
      setLlmCache(cache);
      setTick((t) => t + 1);
    }
    const before = new Map(results.map((r) => [r.id, r.verdict]));
    const after = reconcileAll(data, [...data.letters, ...extra, letter], (t, s) => cache[s + "\n" + t] ?? extractByRules(t, s), new Set([...newIds, id]));
    setChanges(after.filter((r) => before.has(r.id) && before.get(r.id) !== r.verdict).map((r) => ({ id: r.id, from: before.get(r.id)!, to: r.verdict })));
    setExtra([...extra, letter]);
    setSelected(id);
    setView("queue");
  };

  const resetExtra = () => {
    const removed = new Set(extra.map((l) => l.sender + "\n" + l.text));
    setLlmCache((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !removed.has(k))));
    // номера Н-01… выдаются заново: черновики убранных писем не должны достаться новым
    const removedIds = new Set(extra.map((l) => l.id));
    forgetDrafts((id) => removedIds.has(id));
    setExtra([]);
    setChanges(null);
    setSelected(null);
  };

  const needDecision = summary.byVerdict.stop + summary.byVerdict.return + summary.byVerdict.ask;
  // «Разобрано» — документы, по которым бухгалтер принимает решение (дубли и письма-контекст решения не требуют)
  const decidable = results.filter((r) => r.verdict !== "duplicate" && r.verdict !== "letter");
  const decided = decidable.filter((r) => done.has(r.id)).length;

  const queuePanel = (
    <>
      <Queue
        results={results}
        selected={view === "queue" ? selected : null}
        onSelect={(id) => {
          select(id);
          setMobileQueue(false);
        }}
        done={done}
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

  const NAV: { id: View; label: string }[] = [
    { id: "queue", label: "Очередь" },
    { id: "registry", label: "Реестр" },
    { id: "etalon", label: "Проверка на эталоне" },
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
        <nav aria-label="Разделы" className="order-last flex h-10 w-full items-stretch md:order-none md:h-full md:w-auto">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              aria-current={view === n.id ? "page" : undefined}
              className={cn(
                "relative px-3.5 text-[13.5px] whitespace-nowrap transition-colors",
                view === n.id
                  ? "bg-white/10 font-semibold text-white after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:bg-rail-active"
                  : "text-rail-muted hover:bg-white/5 hover:text-rail-fg",
              )}
            >
              {n.label}
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
          <Button size="sm" onClick={() => setView("new")}>
            <Plus />
            Новое письмо
          </Button>
        </div>
      </header>

      {/* Итоги очереди */}
      <section aria-label="Итоги очереди" className="flex shrink-0 flex-wrap items-stretch border-b border-line bg-surface">
        <Stat label="К оплате сейчас" hint={`${summary.payNowCount} ${plural(summary.payNowCount, INVOICES)}`} value={fmtRub(summary.payNow)} tone="pay" link={{ label: "реестр", onClick: () => setView("registry") }} />
        <Stat
          label="Не платить"
          hint="дубли, подмена, цены, итог"
          value={fmtRub(summary.preventedTotal)}
          detail={`Дубли ${num(summary.prevented.duplicate)} ₽
Подмена получателя ${num(summary.prevented.fraud)} ₽
Цены без согласования ${num(summary.prevented.price)} ₽
Ошибка в итоге ${num(summary.prevented.arithmetic)} ₽`}
        />
        <Stat
          label="Отложено"
          hint="не экономия"
          value={fmtRub(summary.deferred)}
          extra={summary.held > 0 ? `+ задержано ${fmtRub(summary.held)} (реквизиты)` : undefined}
          detail={`До приёмки на складе или ответа закупщика. Эти деньги заплатят позже, это не экономия.${summary.held > 0 ? `\nОтдельно задержано ${num(summary.held)} ₽: сверка пройдена, но поставщику пишут о смене реквизитов (П-2).` : ""}`}
        />
        <Stat
          label="Требует решения"
          hint={`стоп ${summary.byVerdict.stop} | вернуть ${summary.byVerdict.return} | вопрос ${summary.byVerdict.ask}`}
          value={String(needDecision)}
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
        <Stat label="Разобрано" hint={`в ящике ${summary.total}`} value={`${decided} из ${decidable.length}`} />
      </section>

      {changes && (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-hl/60 px-5 py-2 text-[13px] text-ink">
          <span className="font-medium">Очередь пересчитана.</span>
          {changes.length === 0 ? (
            <span className="text-muted-foreground">Вердикты остальных документов не изменились.</span>
          ) : (
            changes.map((c) => (
              <button key={c.id} onClick={() => select(c.id)} className="underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
                {c.id}: {VERDICT[c.from].label.toLowerCase()} → {VERDICT[c.to].label.toLowerCase()}
              </button>
            ))
          )}
          <button onClick={() => setChanges(null)} className="ml-auto grid size-6 place-items-center rounded hover:bg-black/5" aria-label="Скрыть">
            <X className="size-3.5" />
          </button>
        </div>
      )}

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
              done={done.has(current.id)}
              onDone={(id, v) => {
                const n = new Set(done);
                if (v) n.add(id);
                else n.delete(id);
                setDone(n);
              }}
              llm={llm.mode}
              onCrossCheck={async (r) => {
                const { ex } = await extractWithLlm(r.text, r.sender, "ИИ");
                setLlmCache((c) => ({ ...c, [r.sender + "\n" + r.text]: ex }));
                setTick((t) => t + 1);
              }}
            />
          )}
          {view === "registry" && <Registry results={results} summary={summary} done={done} onSelect={select} snapshot={data.meta.snapshot} />}
          {view === "etalon" && <EtalonView base={base} summary={baseSummary} onSelect={select} />}
          {view === "new" && <NewLetter onSubmit={addLetter} onClose={() => setView("queue")} llm={llm.mode} nextId={nextId} />}
        </main>
      </div>
    </div>
  );
}

const num = (n: number) => n.toLocaleString("ru-RU");

function Stat({ label, hint, value, detail, tone, link, extra }: { label: string; hint?: string; value: string; detail?: string; tone?: "pay" | "ask"; link?: { label: string; onClick: () => void }; extra?: string }) {
  return (
    <div className="flex min-w-[150px] flex-1 flex-col justify-center border-r border-b border-line px-4 py-2 last:border-r-0 md:border-b-0" title={detail}>
      <span className="line-clamp-2 text-[12px] leading-tight text-muted-foreground">
        {label}
        {hint && <span className="num"><Sep />{hint}</span>}
      </span>
      <span className="mt-0.5 flex items-baseline gap-2">
        <span className={cn("num text-[18px] font-semibold leading-tight tracking-[-0.01em]", tone === "pay" ? "text-pay" : tone === "ask" ? "text-ask" : "text-ink")}>{value}</span>
        {link && (
          <button onClick={link.onClick} className="inline-flex items-center gap-0.5 text-[12px] font-medium text-accent underline decoration-accent/35 underline-offset-[3px] hover:decoration-accent">
            {link.label}
            <ArrowRight className="size-3" aria-hidden />
          </button>
        )}
      </span>
      {extra && <span className="num mt-0.5 text-[11.5px] leading-tight text-muted-foreground">{extra}</span>}
    </div>
  );
}
