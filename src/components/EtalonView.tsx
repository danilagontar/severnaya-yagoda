import { useState } from "react";
import { Check, Play, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ETALON, ETALON_TOTALS } from "@/core/etalon";
import { reconcileAll, summarize, type Summary } from "@/core/reconcile";
import type { CaseData, Result } from "@/core/types";
import { VerdictTag, fmtRub } from "./verdict";
import { Sep } from "@/components/sep";

/**
 * Проверка на эталоне. Колонка «Эталон»: ручная разметка команды, она видна сразу.
 * Колонка «Пилот» появляется только по кнопке: в момент нажатия ядро сверки (то же, что разбирает
 * новые письма) прогоняет 25 писем кейса, время замеряется. Без искусственных задержек.
 */
export function EtalonView({ data, onSelect }: { data: CaseData; onSelect: (id: string) => void }) {
  const [run, setRun] = useState<{ base: Result[]; summary: Summary; ms: number } | null>(null);

  const check = () => {
    const t0 = performance.now();
    const base = reconcileAll(data);
    const summary = summarize(base);
    setRun({ base, summary, ms: performance.now() - t0 });
  };

  const rows = ETALON.map((e) => {
    const r = run?.base.find((x) => x.id === e.id);
    const okVerdict = r?.verdict === e.verdict;
    const okDue = e.due === null || r?.due === e.due;
    const okOrder = r?.orderId === e.order;
    const okTo = r ? [...r.addressees.map((a) => a.role)].sort().join() === [...e.to].sort().join() : false;
    return { e, r, ok: !!r && okVerdict && okDue && okOrder && okTo, okDue, okOrder, okTo };
  });
  const passed = rows.filter((x) => x.ok).length;
  const s = run?.summary;
  const totals: [string, number, number | undefined][] = [
    ["К оплате сразу", ETALON_TOTALS.payNow, s?.payNow],
    ["Дубли", ETALON_TOTALS.prevented.duplicate, s?.prevented.duplicate],
    ["Подмена получателя", ETALON_TOTALS.prevented.fraud, s?.prevented.fraud],
    ["Цены без действующего согласования", ETALON_TOTALS.prevented.price, s?.prevented.price],
    ["Ошибка в итоге", ETALON_TOTALS.prevented.arithmetic, s?.prevented.arithmetic],
    ["Отложено до приёмки / ответа", ETALON_TOTALS.deferred, s?.deferred],
  ];
  const mark = (ok: boolean) => (ok ? <Check className="size-4 text-pay" aria-label="совпало" /> : <X className="size-4 text-stop" aria-label="расхождение" />);
  const msText = run ? (run.ms < 1 ? "меньше чем за 1 мс" : `за ${Math.round(run.ms)} мс`) : "";

  return (
    <div className="@container mx-auto flex max-w-[1080px] flex-col gap-6 px-4 pt-6 pb-12 sm:px-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Проверка на эталоне</h1>
        <p className="mt-1 max-w-[72ch] text-[13.5px] text-muted-foreground">
          Здесь можно проверить, что пилот решает кейс правильно. В колонке «Эталон» ручной разбор всех 25 документов по правилам кейса. Нажмите «Проверить пилот на эталоне»:
          пилот разберёт те же документы сам, а совпадения и расхождения будут отмечены в таблице.
        </p>
      </header>

      {/* карточка слева фиксированной ширины: кнопка и счёт «25/25» занимают одно место, таблица итогов не сдвигается */}
      <div className="grid gap-4 @[640px]:grid-cols-[300px_minmax(0,1fr)]">
        <div
          className={cn(
            "flex min-h-[136px] min-w-[220px] flex-col justify-center rounded-[8px] border px-6 py-4",
            !run ? "border-line bg-surface" : passed === ETALON.length ? "border-pay/40 bg-pay/[0.06]" : "border-stop/40 bg-stop/[0.06]",
          )}
        >
          {run ? (
            <>
              <p className="num text-[34px] font-semibold leading-none text-ink">
                {passed}
                <span className="text-muted-foreground">/{ETALON.length}</span>
              </p>
              <p className="mt-1.5 text-[13px] text-ink">документов совпали с эталоном</p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Посчитано {msText} тем же ядром, что разбирает новые письма.
              </p>
            </>
          ) : (
            <>
              <Button onClick={check}>
                <Play />
                Проверить пилот на эталоне
              </Button>
              <p className="mt-2 max-w-[30ch] text-[12px] text-muted-foreground">Ядро сверки прогонит 25 писем кейса и сравнит с ручной разметкой.</p>
            </>
          )}
        </div>
        <div className="overflow-x-auto rounded-[8px] border border-line bg-surface">
          {/* ширины столбцов фиксированы: по нажатию добавляются данные пилота, а колонки остаются на месте */}
          <table className="w-full table-fixed border-collapse text-[13.5px]">
            <colgroup>
              <col />
              <col className="w-[120px]" />
              <col className="w-[120px]" />
              <col className="w-10" />
            </colgroup>
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">Итог</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Эталон</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Пилот</th>
                <th scope="col" className="w-8 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {totals.map(([label, a, b]) => (
                <tr key={label} className="border-b border-line last:border-b-0">
                  <td className="px-3 py-1.5 text-ink">{label}</td>
                  <td className="num px-3 py-1.5 text-right text-muted-foreground">{fmtRub(a)}</td>
                  <td className="num px-3 py-1.5 text-right font-medium text-ink">{b === undefined ? "" : fmtRub(b)}</td>
                  <td className="px-3 py-1.5">{b === undefined ? null : mark(a === b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ul className="divide-y divide-line rounded-[8px] border border-line bg-surface @[760px]:hidden">
        {rows.map(({ e, r, ok, okDue }) => (
          <li key={e.id}>
            <button onClick={() => onSelect(e.id)} className="grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left hover:bg-surface-2/60">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="num w-10 text-[12px] font-semibold text-ink">{e.id}</span>
                <VerdictTag v={e.verdict} />
                {/* до нажатия место под результат пилота зарезервировано, чтобы строка не сдвигалась */}
                <span className={cn("flex items-center gap-1.5", !r && "invisible")} aria-hidden={!r}>
                  <span className="text-muted-foreground">→</span>
                  <VerdictTag v={r?.verdict ?? e.verdict} />
                </span>
              </span>
              {r ? mark(ok) : <span className="size-4" />}
              <span className="num col-span-2 pl-[46px] text-[12px] text-muted-foreground">
                {e.order}
                {e.due !== null && (
                  <>
                    <Sep />должно {fmtRub(e.due)}
                    <span className={cn(!r && "invisible")} aria-hidden={!r}>
                      <Sep />
                      <span className={okDue ? "text-ink" : "font-semibold text-stop"}>пилот {fmtRub(r ? r.due : e.due)}</span>
                    </span>
                  </>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-[8px] border border-line bg-surface @[760px]:block">
        <table className="w-full table-fixed border-collapse text-[13.5px]">
          <colgroup>
            <col className="w-[76px]" />
            <col className="w-[132px]" />
            <col className="w-[132px]" />
            <col className="w-[76px]" />
            <col className="w-[112px]" />
            <col className="w-[112px]" />
            <col />
            <col className="w-10" />
          </colgroup>
          <thead>
            <tr className="border-b border-line text-left text-[12px] text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">Документ</th>
              <th scope="col" className="px-3 py-2 font-medium">Эталон</th>
              <th scope="col" className="px-3 py-2 font-medium">Пилот</th>
              <th scope="col" className="px-3 py-2 font-medium">Заказ</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Должно быть</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">По сверке</th>
              <th scope="col" className="px-3 py-2 font-medium">Адресаты</th>
              <th scope="col" className="w-8 px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ e, r, ok, okDue, okOrder, okTo }) => (
              <tr key={e.id} className="border-b border-line align-top last:border-b-0 hover:bg-surface-2/60">
                <td className="num px-3 py-1.5">
                  <button onClick={() => onSelect(e.id)} className="font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                    {e.id}
                  </button>
                </td>
                <td className="px-3 py-1.5">
                  <VerdictTag v={e.verdict} />
                </td>
                <td className="px-3 py-1.5">{r && <VerdictTag v={r.verdict} />}</td>
                <td className={cn("num px-3 py-1.5", !r ? "text-muted-foreground" : okOrder ? "text-ink" : "text-stop")}>{r ? r.orderId ?? "" : e.order ?? ""}</td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">{e.due === null ? (e.verdict === "duplicate" ? fmtRub(0) : "") : fmtRub(e.due)}</td>
                <td className={cn("num px-3 py-1.5 text-right", okDue ? "text-ink" : "font-semibold text-stop")}>
                  {!r ? "" : r.due === null || r.due === undefined ? (r.verdict === "duplicate" ? fmtRub(0) : "") : fmtRub(r.due)}
                </td>
                <td className={cn("px-3 py-1.5 text-[12.5px]", !r || okTo ? "text-muted-foreground" : "text-stop")}>{r?.addressees.map((a) => a.name).join(", ")}</td>
                <td className="px-3 py-1.5">{r ? mark(ok) : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="max-w-[75ch] text-[12.5px] text-muted-foreground">
        Решения команды, отличающиеся от буквы эталона: у В-13 и В-21 в эталоне двойной вердикт «вопрос/вернуть», выбран «вопрос» закупщику (как у В-10); у В-25 «стоп/письмо», выбран
        «стоп», потому что письмо требует эскалации финансовому директору.
      </p>
    </div>
  );
}
