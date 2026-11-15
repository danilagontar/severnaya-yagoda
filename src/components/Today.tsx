// План на сегодня: экран при входе, пока не выбран документ. Не повторяет плитки итогов,
// а переводит их в действия: что сделать и кому написать.
import { ArrowRight, ArrowUpRight, CircleCheck, Clock, Play, Undo2, CircleHelp, OctagonX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WAIT_LIMIT_DAYS, waitingDays, type DocStatus, type RegistryState } from "@/core/events";
import type { Result, Verdict } from "@/core/types";
import { fmtRub } from "./verdict";
import { Sep } from "@/components/sep";

const RANK: Record<Verdict, number> = { stop: 0, return: 1, ask: 2, pay: 3, duplicate: 4, letter: 5 };
const WEEKDAY = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

const docs = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "документ" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "документа" : "документов");
const invoices = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "счёт" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "счёта" : "счетов");
const questions = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "вопрос" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "вопроса" : "вопросов");
const stops = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "стоп" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "стопа" : "стопов");

function greeting(now: Date) {
  const h = now.getHours();
  return h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
}

export function Today({
  results,
  statuses,
  registry,
  snapshot,
  newCount,
  onOpen,
  onRegistry,
}: {
  results: Result[];
  statuses: Map<string, DocStatus>;
  registry: RegistryState;
  snapshot: string;
  newCount: number;
  onOpen: (id: string) => void;
  onRegistry: () => void;
}) {
  const now = new Date();
  const st = (r: Result) => statuses.get(r.id);
  // в работе: счета, по которым принимают решение (письма-контексты и дубли не считаем), кроме архива
  const active = results.filter((r) => r.verdict !== "letter" && r.verdict !== "duplicate" && !st(r)?.archived);
  // ждут решения: стоп, вернуть, вопрос без действующего решения; по срочности, новые выше
  const open = results.filter((r) => ["stop", "return", "ask"].includes(r.verdict) && !st(r)?.valid).sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || Number(b.isNew) - Number(a.isNew));
  const toConfirm = registry.unconfirmed;
  const by = (v: Verdict) => open.filter((r) => r.verdict === v);
  const waitingLong = results.filter((r) => {
    const s = st(r);
    return s?.valid && (s.waiting || s.decision?.kind === "returned") && !s.paid && waitingDays(s.at, now) >= WAIT_LIMIT_DAYS;
  });

  // вопросы: кому писать (адресаты из «Кому написать», по числу счетов)
  const toWhom = new Map<string, number>();
  for (const r of by("ask")) for (const n of new Set(r.addressees.map((a) => a.name))) toWhom.set(n, (toWhom.get(n) ?? 0) + 1);
  const whomAll = [...toWhom.entries()].sort((a, b) => b[1] - a[1]);
  const whom = whomAll.slice(0, 3).map(([n, c]) => `${n} ${c}`).join(", ") + (whomAll.length > 3 ? ` и ещё ${whomAll.length - 3}` : "");
  const uniq = (rs: Result[]) => [...new Set(rs.map((r) => r.brief).filter(Boolean))].slice(0, 3).join("; ");

  const tasks: { id: string; icon: typeof Play; tone: string; title: string; detail: string; first: Result | undefined }[] = [];
  const s = by("stop");
  if (s.length) tasks.push({ id: "stop", icon: OctagonX, tone: "text-stop", title: `${s.length} ${stops(s.length)}: передать закупщику и ФД`, detail: `${uniq(s)} (П-2)`, first: s[0] });
  const ret = by("return");
  if (ret.length) tasks.push({ id: "return", icon: Undo2, tone: "text-return", title: `${ret.length} ${invoices(ret.length)} вернуть поставщику`, detail: `${uniq(ret)} (П-8)`, first: ret[0] });
  const ask = by("ask");
  if (ask.length) tasks.push({ id: "ask", icon: CircleHelp, tone: "text-ask", title: `${ask.length} ${questions(ask.length)}: кому написать`, detail: whom || uniq(ask), first: ask[0] });
  if (toConfirm.length)
    tasks.push({
      id: "pay",
      icon: CircleCheck,
      tone: "text-pay",
      title: `${toConfirm.length} ${invoices(toConfirm.length)} подтвердить в реестр`,
      detail: `${fmtRub(round2(toConfirm.reduce((x, r) => x + r.payNow, 0)))}, сверка пройдена`,
      first: toConfirm[0],
    });

  const start = open[0] ?? toConfirm[0];
  const day = `${String(now.getDate()).padStart(2, "0")}.${String(now.getMonth() + 1).padStart(2, "0")}, ${WEEKDAY[now.getDay()]}`;
  const registryLine =
    registry.status === "approved"
      ? "Реестр утверждён ФД, платежи ещё не созданы."
      : registry.status === "submitted"
        ? "Реестр передан ФД на утверждение."
        : registry.items.length
          ? `В реестре ${registry.items.length} ${invoices(registry.items.length)} на ${fmtRub(registry.total)}, ещё не передан ФД.`
          : null;

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-4 pt-6 pb-12 sm:px-6">
      <section>
        <p className="text-[12.5px] text-muted-foreground">
          {day}<Sep />данные на {snapshot}
        </p>
        <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.01em] text-ink">
          {greeting(now)}, в работе {active.length} {docs(active.length)}
        </h1>
        <p className="mt-1 text-[13.5px] text-muted-foreground">
          {open.length || toConfirm.length
            ? [open.length ? `${open.length} ждут вашего решения` : null, toConfirm.length ? `${toConfirm.length} ${invoices(toConfirm.length)} прошли сверку и ждут подтверждения в реестр` : null].filter(Boolean).join(", ") + "."
            : "Всё решено: новых решений не требуется."}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {start && (
            <Button onClick={() => onOpen(start.id)}>
              <Play />
              Начать с самого срочного: {start.id}
              {start.verdict === "stop" ? ", стоп" : start.verdict === "return" ? ", вернуть" : start.verdict === "ask" ? ", вопрос" : ""}
            </Button>
          )}
          <Button variant="outline" onClick={onRegistry}>
            Открыть реестр
            <ArrowUpRight />
          </Button>
        </div>
      </section>

      {tasks.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {tasks.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => t.first && onOpen(t.first.id)}
                className="grid w-full grid-cols-[22px_1fr_auto] items-start gap-x-3 gap-y-0.5 rounded-[10px] border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
              >
                <t.icon className={cn("mt-0.5 size-[18px]", t.tone)} aria-hidden />
                <span className="text-[14.5px] font-semibold text-ink">{t.title}</span>
                <span className="mt-0.5 inline-flex items-center gap-0.5 text-[12.5px] whitespace-nowrap text-accent">
                  открыть {t.first?.id}
                  <ArrowRight className="size-3.5" aria-hidden />
                </span>
                <span className="col-start-2 text-[12.5px] text-muted-foreground">{t.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 rounded-[10px] border border-pay/40 bg-pay/[0.07] px-4 py-3 text-[14px] text-ink">
          <CircleCheck className="size-[18px] text-pay" aria-hidden />
          Всё решено. {registryLine ?? ""}
        </p>
      )}

      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-muted-foreground">
        <Clock className="size-3.5" aria-hidden />
        {waitingLong.length ? (
          <span className="text-ask">
            Ждём ответа дольше {WAIT_LIMIT_DAYS} дней:{" "}
            {waitingLong.map((r, i) => (
              <span key={r.id}>
                <button onClick={() => onOpen(r.id)} className="underline decoration-ask/40 underline-offset-2 hover:decoration-ask">
                  {r.id}
                </button>
                {i < waitingLong.length - 1 ? ", " : ""}
              </span>
            ))}
          </span>
        ) : (
          <span>Ждём ответа дольше {WAIT_LIMIT_DAYS} дней: нет</span>
        )}
        <Sep />
        <span>Новых писем: {newCount}</span>
        {tasks.length > 0 && registryLine && (
          <>
            <Sep />
            <span>{registryLine}</span>
          </>
        )}
      </p>
    </div>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
