import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, Copy, ExternalLink, FileText, Link2, Mail, RotateCcw, Sparkles, TriangleAlert, Info, OctagonX, Undo2 } from "lucide-react";
import { HIT, cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { buildDraft, roleTitle } from "@/core/drafts";
import { COMPANY_DOMAIN } from "@/core/extract";
import type { CompareRow, CrossField, FieldKey, Finding, Result } from "@/core/types";
import { polishDraft, type LlmMode } from "@/llm/provider";
import { VERDICT, VerdictTag, fmtRub, verdictTextColor } from "./verdict";
import { Sep } from "@/components/sep";
import { DecisionPanel } from "@/components/DecisionPanel";
import type { Decision, DocStatus, TimelineItem } from "@/core/events";
import { OrderTimeline } from "@/components/OrderTimeline";
import { AiHint, hintFor, type ConfirmField } from "@/components/AiHint";

const ROW_FIELD: Record<CompareRow["key"], FieldKey | null> = { supplier: null, material: "material", qty: "qty", price: "price", total: "total" };
const FIELD_LABEL: Partial<Record<FieldKey, string>> = {
  invoiceNo: "номер счёта",
  invoiceRef: "ссылка на счёт",
  orderNo: "номер заказа",
  orderDateRef: "дата заказа",
  material: "материал",
  qty: "количество",
  price: "цена",
  total: "итог",
  requisites: "реквизиты",
  resend: "повторная отправка",
  approvalClaim: "ссылка на согласование",
  promise: "обещание поставки",
};
const BINDING: Record<Result["binding"], string> = {
  number: "заказ найден по номеру",
  attributes: "заказ найден без номера: по поставщику, материалу, количеству и дате",
  probable: "вероятный заказ настоящего поставщика",
  none: "заказ не найден",
};

function LetterText({ text, spans, active }: { text: string; spans: Result["ex"]["spans"]; active: FieldKey | null }) {
  const parts = useMemo(() => {
    const list = (Object.entries(spans) as [FieldKey, { start: number; end: number }][])
      .filter(([, s]) => s && s.end > s.start)
      .sort((a, b) => a[1].start - b[1].start);
    const out: { t: string; k?: FieldKey }[] = [];
    let pos = 0;
    for (const [k, s] of list) {
      if (s.start < pos) continue;
      if (s.start > pos) out.push({ t: text.slice(pos, s.start) });
      out.push({ t: text.slice(s.start, s.end), k });
      pos = s.end;
    }
    out.push({ t: text.slice(pos) });
    return out;
  }, [text, spans]);
  return (
    <p className="text-[14px] leading-[1.65] text-ink">
      {parts.map((p, i) =>
        p.k ? (
          <mark key={i} className="src" data-on={active === p.k} title={FIELD_LABEL[p.k]}>
            {p.t}
          </mark>
        ) : (
          <span key={i}>{p.t}</span>
        ),
      )}
    </p>
  );
}


// Черновики писем (в том числе дописанные ИИ и исправленные вручную) переживают перезагрузку.
// Ключ: документ и адресат; «Шаблон» возвращает текст из сверки и стирает сохранённый.
type SavedDraft = { body: string; note: string | null };
const DRAFTS_KEY = "sy.drafts";
const OPEN_KEY = "sy.draftOpen";
const readJson = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const writeJson = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* хранилище недоступно */
  }
};
const draftKey = (r: Result, i: number) => `${r.id}|${r.addressees[i]?.role}|${r.addressees[i]?.name}`;
export function forgetDrafts(match: (docId: string) => boolean) {
  const all = readJson<Record<string, SavedDraft>>(DRAFTS_KEY, {});
  writeJson(DRAFTS_KEY, Object.fromEntries(Object.entries(all).filter(([k]) => !match(k.split("|")[0]))));
  const open = readJson<Record<string, number>>(OPEN_KEY, {});
  writeJson(OPEN_KEY, Object.fromEntries(Object.entries(open).filter(([k]) => !match(k))));
}

const LEVEL_ICON: Record<Finding["level"], { icon: typeof Info; cls: string }> = {
  stop: { icon: OctagonX, cls: "text-stop" },
  return: { icon: Undo2, cls: "text-return" },
  ask: { icon: TriangleAlert, cls: "text-ask" },
  info: { icon: Info, cls: "text-muted-foreground" },
  ok: { icon: Check, cls: "text-pay" },
};

const CELL: Record<string, string> = {
  bad: "bg-stop/[0.07] text-ink ring-1 ring-inset ring-stop/35",
  warn: "bg-ask/[0.08] text-ink ring-1 ring-inset ring-ask/35",
  info: "bg-surface-2 text-ink",
  ok: "text-ink",
  none: "text-muted-foreground",
};

export function DocCard({
  r,
  all,
  onSelect,
  status,
  onDecide,
  timeline,
  llm,
  onCrossCheck,
  onConfirmField,
}: {
  r: Result;
  all: Result[];
  onSelect: (id: string) => void;
  status: DocStatus;
  onDecide: (d: Decision | null) => string | null;
  timeline: TimelineItem[];
  llm: LlmMode;
  onCrossCheck: (r: Result) => Promise<void>;
  onConfirmField: ConfirmField;
}) {
  const [active, setActive] = useState<FieldKey | null>(null);
  // при открытии карточки восстанавливаем последний открытый черновик этого документа
  const [draftIdx, setDraftIdx] = useState<number | null>(() => {
    const i = readJson<Record<string, number>>(OPEN_KEY, {})[r.id];
    return typeof i === "number" && i < r.addressees.length ? i : null;
  });
  const [body, setBodyState] = useState(() => {
    if (draftIdx === null) return "";
    return readJson<Record<string, SavedDraft>>(DRAFTS_KEY, {})[draftKey(r, draftIdx)]?.body ?? buildDraft(r, r.addressees[draftIdx], all).body;
  });
  const [note, setNoteState] = useState<string | null>(() =>
    draftIdx === null ? null : readJson<Record<string, SavedDraft>>(DRAFTS_KEY, {})[draftKey(r, draftIdx)]?.note ?? null,
  );
  const persist = (i: number | null, b: string, n: string | null) => {
    if (i === null) return;
    const all = readJson<Record<string, SavedDraft>>(DRAFTS_KEY, {});
    all[draftKey(r, i)] = { body: b, note: n };
    writeJson(DRAFTS_KEY, all);
  };
  const setBody = (b: string) => {
    setBodyState(b);
    persist(draftIdx, b, note);
  };
  const setNote = (n: string | null) => {
    setNoteState(n);
    persist(draftIdx, body, n);
  };
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const v = VERDICT[r.verdict];
  const draft = draftIdx !== null ? buildDraft(r, r.addressees[draftIdx], all) : null;
  // Адрес: из адресата (поставщик) или из писем сотрудников в данных кейса; иначе пусто: почта откроется без получателя.
  const email = draft
    ? draft.to.email ?? all.find((x) => x.ex.senderDomain === COMPANY_DOMAIN && x.ex.senderName === draft.to.name)?.ex.senderEmail ?? null
    : null;
  const mailto = draft ? `mailto:${email ?? ""}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(body)}` : "#";
  const isLetter = r.ex.kind === "letter";
  const sideFindings = r.findings.filter((f) => f.level !== "info");
  const infoFindings = r.findings.filter((f) => f.level === "info");

  const openDraft = (i: number, fromTemplate = false) => {
    const saved = readJson<Record<string, SavedDraft>>(DRAFTS_KEY, {});
    const key = draftKey(r, i);
    if (fromTemplate) {
      delete saved[key];
      writeJson(DRAFTS_KEY, saved);
    }
    const s = fromTemplate ? undefined : saved[key];
    setDraftIdx(i);
    setBodyState(s?.body ?? buildDraft(r, r.addressees[i], all).body);
    setNoteState(s?.note ?? null);
    setCopied(false);
    writeJson(OPEN_KEY, { ...readJson<Record<string, number>>(OPEN_KEY, {}), [r.id]: i });
  };
  // повторное нажатие на того же адресата сворачивает письмо
  const closeDraft = () => {
    setDraftIdx(null);
    setCopied(false);
    const open = readJson<Record<string, number>>(OPEN_KEY, {});
    delete open[r.id];
    writeJson(OPEN_KEY, open);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`Тема: ${draft?.subject}\n\n${body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setNoteState("Не удалось скопировать. Выделите текст вручную."); // временная подсказка, не сохраняем
    }
  };

  const m = moneyLines(r, status);

  // у письма: номер счёта, к которому оно относится (свой или связанного документа), как в очереди
  const letterTo = isLetter ? r.ex.invoiceNo ?? r.ex.invoiceRef ?? r.related.map((id) => all.find((y) => y.id === id)?.ex.invoiceNo).find(Boolean) : undefined;

  // Связанные документы, которых нет в истории заказа (другой заказ или заказ не найден): показываются под историей
  const inTimeline = new Set(timeline.flatMap((t) => (t.docId ? [t.docId] : [])));
  const others = r.related.filter((id) => !inTimeline.has(id)).flatMap((id) => {
    const x = all.find((y) => y.id === id);
    return x ? [x] : [];
  });

  // Черновик письма адресату: отдельный блок над «Решением бухгалтера»
  const draftBlock =
    r.addressees.length > 0 ? (
        <section aria-labelledby="to-h" className="rounded-[8px] border border-line bg-surface">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <h2 id="to-h" className="mr-2 flex items-center gap-1.5 text-[15px] font-semibold text-ink">
              <Mail className="size-4 text-muted-foreground" aria-hidden />
              Кому написать
            </h2>
            {r.addressees.map((a, i) => (
              <Button key={i} variant={draftIdx === i ? "default" : "outline"} size="sm" aria-pressed={draftIdx === i} onClick={() => (draftIdx === i ? closeDraft() : openDraft(i))} title={draftIdx === i ? "Свернуть письмо" : a.reason}>
                {a.name}
                <span className={cn("text-[12px] font-normal", draftIdx === i ? "opacity-80" : "text-muted-foreground")}>{roleTitle(a)}</span>
              </Button>
            ))}
          </div>
          {draft ? (
            <div className="flex flex-col gap-2 px-4 py-3">
              <p className="text-[13px]">
                <span className="text-muted-foreground">Тема: </span>
                <span className="font-medium text-ink">{draft.subject}</span>
                <span className="text-muted-foreground"><Sep />кому: </span>
                {email ? <span className="num text-ink">{email}</span> : <span className="text-ask">адреса нет в данных кейса</span>}
                {/* причина только для бухгалтера, в письмо не идёт */}
                <span className="text-muted-foreground"><Sep />причина: {draft.to.reason}</span>
              </p>
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={Math.min(14, body.split("\n").length + 1)} className="num resize-y bg-surface text-[13.5px] leading-relaxed" aria-label="Текст письма" />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={copy}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Скопировано" : "Скопировать письмо"}
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <a href={mailto} title={email ? `Откроется почтовая программа: ${email}` : "Адреса в данных кейса нет: почта откроется без получателя"}>
                    <ExternalLink />
                    Открыть в почте
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={llm !== "gigachat" || busy}
                  title={llm !== "gigachat" ? "ИИ не подключён: задайте ключ в .env.local (docs/llm.md)" : undefined}
                  onClick={async () => {
                    setBusy(true);
                    const res = await polishDraft({ ...draft, body }, r.verdict);
                    setBodyState(res.body);
                    setNoteState(res.note);
                    persist(draftIdx, res.body, res.note);
                    setBusy(false);
                  }}
                >
                  <Sparkles />
                  {busy ? "ИИ пишет…" : "Дописать текст с ИИ"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openDraft(draftIdx!, true)}>
                  <RotateCcw />
                  Шаблон
                </Button>
                <span className="text-[12.5px] text-muted-foreground">{note ?? "Числа в письме взяты из сверки и не меняются при переписывании."}</span>
              </div>
            </div>
          ) : (
            <p className="flex items-center gap-1.5 px-4 py-3 text-[13px] text-muted-foreground">
              Выберите адресата, и черновик соберётся из причин выше
              <ArrowRight className="size-3.5" aria-hidden />
            </p>
          )}
        </section>
    ) : null;

  return (
    <article className="@container mx-auto flex max-w-[1080px] flex-col gap-5 px-4 pt-5 pb-10 sm:px-6" aria-labelledby="doc-title">
      {/* Заголовок документа */}
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="num text-[13px] text-muted-foreground">
            {r.id}<Sep />получено {r.received}<Sep />{r.ex.senderEmail ?? r.sender}
          </p>
          {/* номер счёта и заказа первыми, как в строке очереди: по ним бухгалтер ищет документ; дальше поставщик */}
          <h1 id="doc-title" className="num mt-1 text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink text-balance">
            {isLetter ? (
              <>Письмо{letterTo && <span className="font-normal"><Sep />к счёту {letterTo}</span>}</>
            ) : (
              <>
                {r.ex.invoiceNo ? `Счёт ${r.ex.invoiceNo}` : "Счёт без номера"}
                {r.orderId && <span className="font-normal"><Sep />{r.orderId}</span>}
              </>
            )}
            {r.ex.kind === "correction" && <span className="font-normal text-muted-foreground"> (исправленный)</span>}
            {/* поставщик в той же строке, обычным начертанием */}
            <span className="font-normal"><Sep />{r.supplier ?? r.ex.senderName ?? "Отправитель не указан"}</span>
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {isLetter ? (r.orderId ? `заказ ${r.orderId} по связанному счёту` : BINDING[r.binding]) : BINDING[r.binding]}
            {r.orderSummary && <><Sep />{r.orderSummary}</>}
          </p>
        </div>
      </header>

      {/* Вердикт */}
      <section
        aria-label="Вердикт"
        className={cn("grid gap-x-8 gap-y-3 rounded-[8px] border bg-surface p-4 @[700px]:grid-cols-[minmax(0,1fr)_auto]", r.verdict === "stop" ? "border-stop/50" : "border-line")}
      >
        <div className="min-w-0">
          <VerdictTag v={r.verdict} size="lg" />
          <p className="mt-2.5 text-[15px] leading-snug text-ink text-pretty">{r.headline}</p>
        </div>
        {!isLetter && (
          <dl className="grid grid-cols-[auto_auto] content-start gap-x-6 gap-y-1 text-right @[700px]:min-w-[260px]">
            <dt className="text-left text-[13px] text-muted-foreground">По счёту</dt>
            <dd className="num text-[15px] text-ink">{fmtRub(r.invoiced)}</dd>
            {m.showDue && (
              <>
                <dt className="text-left text-[13px] text-muted-foreground">По сверке</dt>
                <dd className={cn("num text-[15px]", m.diff ? "font-semibold text-ink" : "text-ink")}>{fmtRub(r.due)}</dd>
              </>
            )}
            {m.diff && (
              <>
                <dt className="text-left text-[13px] text-muted-foreground">{m.diff.label}</dt>
                <dd className="num text-[15px] text-ink">{fmtRub(m.diff.amount)}</dd>
              </>
            )}
            {/* нижняя строка: что будет со счётом дальше, а не «0 ₽» */}
            <div className="col-span-2 mt-1 flex items-baseline justify-between gap-6 border-t border-line pt-1.5">
              <dt className={cn("text-left text-[13px] font-medium", m.state.amount === undefined && m.state.tone ? m.state.tone : "text-ink")}>{m.state.label}</dt>
              {m.state.amount !== undefined && <dd className={cn("num text-[18px] font-semibold", m.state.tone)}>{fmtRub(m.state.amount)}</dd>}
            </div>
            {m.state.hint && <p className="col-span-2 text-right text-[12px] text-muted-foreground">{m.state.hint}</p>}
          </dl>
        )}
      </section>

      {/* Сверка: Заказ / Согласование / Приёмка / Счёт */}
      {!isLetter && r.compare.length > 0 && (
        <section aria-labelledby="cmp-h">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="cmp-h" className="text-[15px] font-semibold text-ink">
              Сверка
            </h2>
            <p className="text-[12px] text-muted-foreground">
              {/* на сенсорном экране наведения нет: ячейка подсвечивает письмо по нажатию (фокус), а письмо ниже таблицы */}
              <span className="pointer-coarse:hidden">Наведите на ячейку счёта, и в письме подсветится, откуда взято число</span>
              <span className="hidden pointer-coarse:inline">Нажмите на ячейку счёта, и в письме ниже подсветится, откуда взято число</span>
            </p>
          </div>
          {(() => {
            const showAppr = r.compare.some((x) => x.approval);
            const showAcc = r.compare.some((x) => x.acceptance);
            const cell = (row: CompareRow) => {
              const f = ROW_FIELD[row.key];
              const hasSpan = !!(f && r.ex.spans[f]);
              const hint = row.key === "supplier" ? undefined : hintFor(r.ex.crossCheck?.fields, row.key === "qty" ? ["qty", "pack"] : [row.key]);
              const pending = hint && hint.status !== "confirmed";
              return (
                <div
                  tabIndex={hasSpan ? 0 : -1}
                  onMouseEnter={() => f && setActive(f)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => f && setActive(f)}
                  onBlur={() => setActive(null)}
                  className={cn("num rounded-[5px] px-2 py-1.5 transition-colors", CELL[row.status], hasSpan && "cursor-help")}
                >
                  <div className="flex items-start justify-between gap-2">
                    {!pending && <span>{row.invoice ?? ""}</span>}
                    {row.status === "bad" && <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-stop" aria-label="расхождение" />}
                    {row.status === "warn" && <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-ask" aria-label="требует внимания" />}
                  </div>
                  {row.note && <div className="mt-0.5 text-[12px] text-muted-foreground">{row.note}</div>}
                  {hint && <AiHint f={hint} model={r.ex.crossCheck?.model} onConfirm={onConfirmField} />}
                </div>
              );
            };
            return (
              <div className="rounded-[8px] border border-line bg-surface">
                {/* широкая карточка: таблица; пустые у всех строк колонки скрыты */}
                <table className="hidden w-full border-collapse text-[13.5px] @[620px]:table">
                  <thead>
                    <tr className="border-b border-line text-left text-[12px] text-muted-foreground">
                      <th scope="col" className="w-[110px] px-3 py-2 font-medium"></th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Заказ <span className="font-normal">(1С:ERP)</span>
                      </th>
                      {showAppr && (
                        <th scope="col" className="px-3 py-2 font-medium">
                          Согласование <span className="font-normal">(Directum RX)</span>
                        </th>
                      )}
                      {showAcc && <th scope="col" className="px-3 py-2 font-medium">Приёмка</th>}
                      <th scope="col" className="px-3 py-2 font-medium text-ink">Счёт</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.compare.map((row) => (
                      <tr key={row.key} className="border-b border-line align-top last:border-b-0">
                        <th scope="row" className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                          {row.label}
                        </th>
                        <td className="num px-3 py-2.5 text-ink">{row.order}</td>
                        {showAppr && <td className="px-3 py-2.5 text-[13px] text-ink">{row.approval}</td>}
                        {showAcc && <td className="num px-3 py-2.5 text-ink">{row.acceptance}</td>}
                        <td className="w-[34%] p-1">{cell(row)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* узкая карточка: список по строкам сверки */}
                <dl className="divide-y divide-line @[620px]:hidden">
                  {r.compare.map((row) => (
                    <div key={row.key} className="px-3 py-2.5">
                      <dt className="text-[12px] font-semibold text-ink">{row.label}</dt>
                      <dd className="grid grid-cols-2 gap-x-3 text-[13px]">
                        <span className="flex min-w-0 flex-col gap-1 pt-1.5 text-ink">
                          {row.order && (
                            <span>
                              <span className="block text-[11.5px] text-muted-foreground">Заказ</span>
                              <span className="num">{row.order}</span>
                            </span>
                          )}
                          {row.approval && (
                            <span>
                              <span className="block text-[11.5px] text-muted-foreground">Согласование</span>
                              {row.approval}
                            </span>
                          )}
                          {row.acceptance && (
                            <span>
                              <span className="block text-[11.5px] text-muted-foreground">Приёмка</span>
                              <span className="num">{row.acceptance}</span>
                            </span>
                          )}
                        </span>
                        <span className="min-w-0">
                          <span className="block px-2 pt-1.5 text-[11.5px] text-muted-foreground">Счёт</span>
                          {cell(row)}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            );
          })()}
          {r.conversion && (
            <p className="num mt-2 text-[13px] text-ink">
              <span className="text-muted-foreground">Пересчёт фасовки (П-7): </span>
              {r.conversion}
            </p>
          )}
        </section>
      )}

      <div className="grid gap-5 @[860px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Причины */}
        <section aria-labelledby="why-h">
          <h2 id="why-h" className="mb-2 text-[15px] font-semibold text-ink">
            Почему так
          </h2>
          <ul className="flex flex-col gap-2">
            {[...sideFindings, ...infoFindings].map((f, i) => {
              const L = LEVEL_ICON[f.level];
              const Icon = L.icon;
              const target = f.source && /^[ВН]-\d+/.test(f.source) ? f.source : null;
              return (
                <li key={i} className="grid grid-cols-[16px_1fr] gap-2.5 text-[13.5px] leading-snug">
                  <Icon className={cn("mt-[2px] size-4", L.cls)} aria-hidden />
                  <div>
                    <span className="mr-1.5 inline-block rounded-[4px] bg-surface-2 px-1 text-[11.5px] font-semibold text-muted-foreground ring-1 ring-inset ring-line">{f.rule}</span>
                    <span className="text-ink">{f.text}</span>
                    {f.source && (
                      target ? (
                        <button onClick={() => onSelect(target)} className={cn(HIT, "ml-1.5 text-[12.5px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent")}>
                          открыть {target}
                        </button>
                      ) : (
                        <span className="text-[12px] text-muted-foreground"><Sep />{f.source}</span>
                      )
                    )}
                  </div>
                </li>
              );
            })}
            {!r.findings.length && <li className="text-muted-foreground">Расхождений нет: заказ, приёмка и цена сходятся.</li>}
          </ul>
        </section>

        {/* Исходное письмо */}
        <section aria-labelledby="src-h">
          <h2 id="src-h" className="mb-2 flex items-center gap-1.5 text-[15px] font-semibold text-ink">
            <FileText className="size-4 text-muted-foreground" aria-hidden />
            Письмо
            <span className="ml-auto text-[12px] font-normal text-muted-foreground">
              {r.ex.crossCheck && !r.ex.crossCheck.error ? "разбор: правила и ИИ" : "разбор: правила"}
            </span>
          </h2>
          <div className="rounded-[8px] border border-line bg-surface px-4 py-3">
            <p className="mb-1.5 text-[12px] text-muted-foreground">{r.sender}</p>
            <LetterText text={r.text} spans={r.ex.spans} active={active} />
            {r.ex.missing.length > 0 && (
              <p className="mt-2 text-[12.5px] text-ask">Не найдено в тексте: {r.ex.missing.map((m) => FIELD_LABEL[m]).join(", ")}.</p>
            )}
          </div>
          <CrossCheckPanel r={r} llm={llm} onRun={onCrossCheck} onConfirm={onConfirmField} />
        </section>
      </div>

      <span className="sr-only">{v.long}</span>

      {/* Кому написать: отдельно от кнопок решения */}
      {draftBlock}

      {/* Решение бухгалтера: дубли и письма-контекст решения не требуют */}
      <DecisionPanel key={r.id + r.verdict} r={r} status={status} onDecide={onDecide} />
      {(r.verdict === "letter" || r.verdict === "duplicate") && <NoDecision r={r} onSelect={onSelect} />}

      {/* История заказа: в самом низу, под решением */}
      <OrderTimeline orderId={r.orderId} items={timeline} currentId={r.id} onSelect={onSelect} others={others} />
    </article>
  );
}

/**
 * Суммы в блоке вердикта: «по счёту», «по сверке», разница с причиной и что будет дальше.
 * Слова те же, что на плитках и в реестре: «отложено», «к оплате», «в реестре».
 */
function moneyLines(r: Result, s: DocStatus) {
  const rules = r.findings.filter((f) => f.level !== "info").map((f) => f.rule);
  const gap = r.invoiced !== null && r.due !== null ? Math.round((r.invoiced - r.due) * 100) / 100 : 0;
  let diff: { label: string; amount: number } | null = null;
  if (gap > 0 && r.verdict !== "stop" && r.verdict !== "duplicate") {
    const cat = r.prevented[0]?.category;
    const label =
      r.deferred > 0
        ? rules.includes("П-4") || rules.includes("П-5")
          ? "Отложено до приёмки"
          : "Отложено до ответа"
        : cat === "price"
          ? "Цена без согласования"
          : cat === "arithmetic"
            ? "Ошибка в итоге"
            : "Разница";
    diff = { label, amount: gap };
  }
  const who = r.addressees[0]?.name;
  type State = { label: string; amount?: number; tone?: string; hint?: string };
  let state: State;
  if (s.inRegistry) state = { label: s.decision?.kind === "pay-override" ? "В реестре по решению" : "В реестре", amount: s.amount, tone: "text-pay" };
  else if (r.verdict === "pay") state = { label: "К оплате", amount: r.payNow, tone: "text-ink", hint: "В реестр попадёт после подтверждения" };
  else if (r.verdict === "ask" && rules.includes("П-2")) state = { label: "Задержан до допсоглашения о реквизитах" };
  else if (r.verdict === "ask") state = { label: who ? `Платёж после ответа: ${who}` : "Платёж после ответа" };
  else if (r.verdict === "return") state = { label: "Ждём исправленный счёт" };
  else if (r.verdict === "stop") state = { label: "Платить нельзя", tone: "text-stop" };
  else if (r.verdict === "duplicate") state = { label: r.replacedBy ? `Не платить: заменён ${r.replacedBy}` : r.duplicateOf ? `Не платить: копия ${r.duplicateOf}` : "Не платить" };
  else state = { label: "" };
  if (s.valid && s.decision?.kind === "reject") state = { label: "Не платить по решению бухгалтера" };
  return { showDue: r.verdict !== "stop" && r.verdict !== "duplicate", diff, state };
}

const CROSS: Record<CrossField["status"], { label: string; cls: string }> = {
  match: { label: "совпало", cls: "text-pay" },
  diff: { label: "расходится", cls: "text-stop font-medium" },
  "llm-only": { label: "дополнил ИИ", cls: "text-ask" },
  "rules-only": { label: "только правила", cls: "text-muted-foreground" },
  "llm-rejected": { label: "отклонено: нет в письме", cls: "text-return" },
  "both-empty": { label: "", cls: "" },
  confirmed: { label: "подтвердил бухгалтер", cls: "text-pay" },
};
// поля, у которых есть строка в сверке: там подсказка и кнопки; остальные подтверждаются в панели разборов
const IN_COMPARE = new Set<CrossField["key"]>(["material", "qty", "pack", "price", "total"]);

/** Два независимых разбора письма: правила и GigaChat. */
function CrossCheckPanel({ r, llm, onRun, onConfirm }: { r: Result; llm: LlmMode; onRun: (r: Result) => Promise<void>; onConfirm: ConfirmField }) {
  const [busy, setBusy] = useState(false);
  const cc = r.ex.crossCheck;
  // Подсказки ИИ сами: правила не прочитали поле счёта (или увидели только письмо со словом «счёт» и числами).
  // Разбор кэшируется по тексту письма, поэтому повторно не запрашивается.
  const needsAi =
    llm === "gigachat" &&
    !cc &&
    (r.ex.missing.length > 0 || (r.ex.kind === "letter" && r.ex.topic === "other" && /сч[её]т|invoice/i.test(r.text) && /\d{2,}/.test(r.text)));
  useEffect(() => {
    if (!needsAi) return;
    let alive = true;
    setBusy(true);
    onRun(r).finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.id, needsAi]);
  if (llm !== "gigachat" && !cc) return null;
  if (!cc || cc.error) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
        <Button
          size="xs"
          variant="outline"
          className={HIT}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onRun(r);
            setBusy(false);
          }}
        >
          <Sparkles />
          {busy ? "ИИ читает письмо…" : "Сверить разбор с ИИ"}
        </Button>
        {cc?.error ? <span className="text-ask">Не получилось: {cc.error}</span> : <span>Второй, независимый разбор письма моделью.</span>}
      </div>
    );
  }
  const diffs = cc.fields.filter((f) => f.status === "diff").length;
  return (
    <div className="mt-3 rounded-[8px] border border-line bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-line px-3 py-2">
        <p className="text-[13px] font-medium text-ink">
          Два разбора письма:{" "}
          <span className={diffs ? "text-stop" : "text-pay"}>
            совпало {cc.matched} из {cc.compared}
          </span>
        </p>
        <p className="text-[12px] text-muted-foreground">правила и ИИ читали письмо независимо</p>
      </div>
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="text-left text-[11.5px] text-muted-foreground">
            <th scope="col" className="px-3 pt-1.5 pb-1 font-medium">Поле</th>
            <th scope="col" className="px-2 pt-1.5 pb-1 font-medium">Правила</th>
            <th scope="col" className="px-2 pt-1.5 pb-1 font-medium">ИИ</th>
            <th scope="col" className="px-3 pt-1.5 pb-1 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {cc.fields.map((f) => (
            <tr key={f.key} className={cn("border-t border-line align-top", f.status === "diff" && "bg-stop/[0.06]")}>
              <th scope="row" className="px-3 py-1.5 text-left font-normal text-muted-foreground">{f.label}</th>
              <td className="num px-2 py-1.5 text-ink">{f.rules}</td>
              <td className="num px-2 py-1.5 text-ink">{f.llm}</td>
              <td className={cn("px-3 py-1.5 text-right", CROSS[f.status].cls)}>
                {r.ex.kind === "letter" && f.status === "llm-only" ? (
                  <span className="whitespace-nowrap text-muted-foreground">в письме без счёта не используется</span>
                ) : !IN_COMPARE.has(f.key) && (f.status === "llm-only" || (f.status === "diff" && f.critical) || f.status === "confirmed") ? (
                  <div className="ml-auto max-w-[260px] text-left">
                    <AiHint f={f} model={cc.model} onConfirm={onConfirm} />
                  </div>
                ) : IN_COMPARE.has(f.key) && (f.status === "llm-only" || (f.status === "diff" && f.critical)) ? (
                  <span className="whitespace-nowrap">{CROSS[f.status].label}, подтвердите в сверке</span>
                ) : (
                  <span className="whitespace-nowrap">{CROSS[f.status].label}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-3 py-2 text-[11.5px] text-muted-foreground">
        Суммы и вердикт считает код. Поля, которых нет в разборе правил, берутся у ИИ, только если такие числа есть в тексте письма, и становятся подсказкой: пока бухгалтер её не подтвердит, счёт остаётся в «вопросе». Если разборы расходятся в заказе, количестве, цене или итоге, верное значение выбирает бухгалтер.
      </p>
    </div>
  );
}

/** Вместо блока решения у письма-контекста и дубля: почему решать не нужно и где решение по оплате. */
function NoDecision({ r, onSelect }: { r: Result; onSelect: (id: string) => void }) {
  const main = r.replacedBy ?? r.duplicateOf ?? null;
  const docs = main ? [main] : r.related;
  const why = r.replacedBy ? "заменён исправленной версией" : r.duplicateOf ? "копия счёта, платим по оригиналу" : docs.length ? "письмо без счёта, учтено в" : "письмо без счёта";
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-[8px] border border-line bg-surface px-4 py-3 text-[13.5px] text-muted-foreground">
      <Info className="size-4 shrink-0" aria-hidden />
      <span>
        Решение не нужно: {why}
        {r.replacedBy || r.duplicateOf ? "" : docs.length ? "" : "."}
      </span>
      {docs.map((id, i) => (
        <span key={id}>
          <button onClick={() => onSelect(id)} className={cn(HIT, "text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent")}>
            {id}
          </button>
          {i < docs.length - 1 ? "," : ""}
        </span>
      ))}
    </p>
  );
}
