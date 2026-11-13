import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ETALON, ETALON_TOTALS } from "@/core/etalon";
import type { Result } from "@/core/types";
import type { Summary } from "@/core/reconcile";
import { VerdictTag, fmtRub } from "./verdict";
import { Sep } from "@/components/sep";

export function EtalonView({ base, summary, onSelect }: { base: Result[]; summary: Summary; onSelect: (id: string) => void }) {
  const rows = ETALON.map((e) => {
    const r = base.find((x) => x.id === e.id);
    const okVerdict = r?.verdict === e.verdict;
    const okDue = e.due === null || r?.due === e.due;
    const okOrder = r?.orderId === e.order;
    const okTo = r ? [...r.addressees.map((a) => a.role)].sort().join() === [...e.to].sort().join() : false;
    return { e, r, ok: okVerdict && okDue && okOrder && okTo, okVerdict, okDue, okOrder, okTo };
  });
  const passed = rows.filter((x) => x.ok).length;
  const totals: [string, number, number][] = [
    ["К оплате сразу", ETALON_TOTALS.payNow, summary.payNow],
    ["Дубли", ETALON_TOTALS.prevented.duplicate, summary.prevented.duplicate],
    ["Подмена получателя", ETALON_TOTALS.prevented.fraud, summary.prevented.fraud],
    ["Цены без действующего согласования", ETALON_TOTALS.prevented.price, summary.prevented.price],
    ["Ошибка в итоге", ETALON_TOTALS.prevented.arithmetic, summary.prevented.arithmetic],
    ["Отложено до приёмки / ответа", ETALON_TOTALS.deferred, summary.deferred],
  ];

  return (
    <div className="@container mx-auto flex max-w-[1080px] flex-col gap-6 px-4 pt-6 pb-12 sm:px-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Проверка на эталоне</h1>
        <p className="mt-1 max-w-[70ch] text-[13.5px] text-muted-foreground">
          Ручная разметка всех 25 документов кейса (data/case04_etalon.md) против результата ядра сверки: вердикт, заказ, сумма по сверке и адресаты вопроса. Те же проверки есть в автотестах
          <span className="num"> pnpm test</span>. Новые письма в эту проверку не входят.
        </p>
      </header>

      <div className="grid gap-4 @[640px]:grid-cols-[auto_1fr]">
        <div className={cn("flex flex-col justify-center rounded-[8px] border px-6 py-4", passed === ETALON.length ? "border-pay/40 bg-pay/[0.06]" : "border-stop/40 bg-stop/[0.06]")}>
          <p className="num text-[34px] font-semibold leading-none text-ink">
            {passed}
            <span className="text-muted-foreground">/{ETALON.length}</span>
          </p>
          <p className="mt-1.5 text-[13px] text-ink">документов совпали с эталоном</p>
        </div>
        <div className="overflow-x-auto rounded-[8px] border border-line bg-surface">
          <table className="w-full border-collapse text-[13.5px]">
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
                  <td className="num px-3 py-1.5 text-right font-medium text-ink">{fmtRub(b)}</td>
                  <td className="px-3 py-1.5">{a === b ? <Check className="size-4 text-pay" aria-label="совпало" /> : <X className="size-4 text-stop" aria-label="не совпало" />}</td>
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
                <span className="text-muted-foreground">→</span>
                {r && <VerdictTag v={r.verdict} />}
              </span>
              {ok ? <Check className="size-4 text-pay" aria-label="совпало" /> : <X className="size-4 text-stop" aria-label="расхождение" />}
              <span className="num col-span-2 pl-[46px] text-[12px] text-muted-foreground">
                {r?.orderId}
                {e.due !== null && (
                  <>
                    <Sep />должно {fmtRub(e.due)}<Sep /><span className={okDue ? "text-ink" : "font-semibold text-stop"}>пилот {fmtRub(r?.due)}</span>
                  </>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-[8px] border border-line bg-surface @[760px]:block">
        <table className="w-full border-collapse text-[13.5px]">
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
                <td className={cn("num px-3 py-1.5", okOrder ? "text-ink" : "text-stop")}>{r?.orderId ?? ""}</td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">{e.due === null ? (e.verdict === "duplicate" ? fmtRub(0) : "") : fmtRub(e.due)}</td>
                <td className={cn("num px-3 py-1.5 text-right", okDue ? "text-ink" : "font-semibold text-stop")}>
                  {r?.due === null || r?.due === undefined ? (r?.verdict === "duplicate" ? fmtRub(0) : "") : fmtRub(r.due)}
                </td>
                <td className={cn("px-3 py-1.5 text-[12.5px]", okTo ? "text-muted-foreground" : "text-stop")}>{r?.addressees.map((a) => a.name).join(", ")}</td>
                <td className="px-3 py-1.5">{ok ? <Check className="size-4 text-pay" aria-label="совпало" /> : <X className="size-4 text-stop" aria-label="расхождение" />}</td>
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
