import { useEffect, useRef, useState } from "react";
import { Cpu, RefreshCw } from "lucide-react";
import { getUsage, type LlmMode, type LlmUsage as Usage } from "@/llm/provider";

const n = (x: number) => x.toLocaleString("ru-RU");

/** Расход токенов GigaChat: счётчик в шапке и сводка по клику. */
export function LlmUsage({ mode, model, tick }: { mode: LlmMode; model: string | null; tick: number }) {
  const [u, setU] = useState<Usage | null>(null);
  const [bal, setBal] = useState<{ ok: boolean; data?: unknown; error?: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [top, setTop] = useState(0); // для телефона: панель под кнопкой, во всю ширину экрана
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode === "gigachat") getUsage().then((r) => r && setU(r.usage));
  }, [mode, tick]);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const refresh = async () => {
    setLoading(true);
    const r = await getUsage(true);
    if (r) {
      setU(r.usage);
      setBal(r.balance);
    }
    setLoading(false);
  };

  if (mode !== "gigachat") return <span className="hidden text-[12px] text-rail-muted xl:inline">поля: правила</span>;

  // остаток только для модели, которой пользуется пилот (имя модели в интерфейсе не показываем)
  const allRows = Array.isArray((bal?.data as { balance?: unknown[] })?.balance) ? (bal!.data as { balance: { usage: string; value: number }[] }).balance : null;
  const tier = (model ?? "").match(/(Max|Pro|Ultra|Lite)$/i)?.[1]?.toLowerCase() ?? "";
  const mine = allRows?.find((b) => (b.usage.match(/(Max|Pro|Ultra|Lite)$/i)?.[1]?.toLowerCase() ?? "") === tier) ?? null;
  const balRows = mine ? [{ usage: "Текущая модель", value: mine.value }] : null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={(e) => {
          setTop(e.currentTarget.getBoundingClientRect().bottom + 8);
          setOpen(!open);
          if (!open) refresh();
        }}
        aria-expanded={open}
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] text-rail-muted hover:bg-white/10 hover:text-rail-fg"
        title="Расход токенов ИИ"
      >
        <Cpu className="size-3.5" aria-hidden />
        ИИ
        <span className="num text-rail-fg">{u ? n(u.total) : "0"}</span>
        <span className="hidden sm:inline">ток.</span>
      </button>
      {open && (
        <div
          style={{ "--pop-top": `${top}px` } as React.CSSProperties}
          className="fixed inset-x-4 top-[var(--pop-top)] z-30 max-h-[calc(100dvh-var(--pop-top)-16px)] overflow-y-auto rounded-[8px] sm:absolute sm:inset-x-auto sm:top-10 sm:right-0 sm:max-h-none sm:w-[300px] border border-line bg-surface p-3 text-[13px] text-ink shadow-[0_8px_24px_rgba(16,18,24,0.18)]">
          <div className="mb-2 flex items-center justify-between">
            <p className="font-semibold">Расход ИИ</p>
            <button onClick={refresh} className="grid size-7 place-items-center rounded hover:bg-surface-2" aria-label="Обновить">
              <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
            </button>
          </div>
          <dl className="num grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Запросов</dt>
            <dd>{n(u?.requests ?? 0)}</dd>
            <dt className="text-muted-foreground">Токены запроса</dt>
            <dd>{n(u?.prompt ?? 0)}</dd>
            <dt className="text-muted-foreground">Токены ответа</dt>
            <dd>{n(u?.completion ?? 0)}</dd>
            <dt className="font-medium">Всего</dt>
            <dd className="font-medium">{n(u?.total ?? 0)}</dd>
          </dl>
          {u?.last && (
            <p className="mt-2 text-[12px] text-muted-foreground">
              Последний: {u.last.purpose}, {n(u.last.total)} ток.
            </p>
          )}
          <div className="mt-3 border-t border-line pt-2">
            <p className="mb-1 font-medium">Остаток</p>
            {balRows ? (
              <dl className="num grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-[12.5px]">
                {balRows.map((b) => (
                  <div key={b.usage} className="contents">
                    <dt className="text-muted-foreground">{b.usage}</dt>
                    <dd>{n(b.value)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-[12px] text-muted-foreground">
                {loading ? "Загружаю…" : bal?.ok === false ? `Остаток не получен (${bal.error}). Он виден в личном кабинете провайдера.` : "Нет данных."}
              </p>
            )}
          </div>
          <p className="mt-2 text-[11.5px] text-muted-foreground">Счётчик с запуска pnpm dev. Журнал запросов: logs/gigachat-usage.jsonl</p>
        </div>
      )}
    </div>
  );
}
