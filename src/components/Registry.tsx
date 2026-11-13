import { Check, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INVOICES, cn, plural } from "@/lib/utils";
import type { Result } from "@/core/types";
import type { Summary } from "@/core/reconcile";
import { VerdictTag, fmtRub } from "./verdict";

function csv(rows: (string | number)[][]) {
  return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
}

export function Registry({ results, summary, done, onSelect, snapshot }: { results: Result[]; summary: Summary; done: Set<string>; onSelect: (id: string) => void; snapshot: string }) {
  const pay = results.filter((r) => r.verdict === "pay");
  const held = results.filter((r) => r.ex.kind !== "letter" && r.verdict !== "pay" && r.verdict !== "duplicate");
  const confirmed = pay.filter((r) => done.has(r.id));

  const download = () => {
    const rows: (string | number)[][] = [["Документ", "Поставщик", "Счёт", "Заказ", "Сумма, руб.", "Подтверждено бухгалтером"]];
    for (const r of pay) rows.push([r.id, r.supplier ?? "", r.ex.invoiceNo ?? "", r.orderId ?? "", r.payNow, done.has(r.id) ? "да" : "нет"]);
    rows.push(["", "", "", "Итого", summary.payNow, ""]);
    const blob = new Blob(["﻿" + csv(rows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "platezhnyy-reestr.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000); // сразу отзывать нельзя: Firefox и Safari не успевают скачать
  };

  return (
    <div className="@container mx-auto flex max-w-[1080px] flex-col gap-8 px-4 pt-6 pb-12 sm:px-6">
      <section aria-labelledby="reg-h">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 id="reg-h" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">
              Платёжный реестр
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              На утверждение финансовому директору (П-9) · срез {snapshot} · подтверждено бухгалтером {confirmed.length} из {pay.length}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={download}>
            <Download />
            Скачать CSV
          </Button>
        </div>
        <PayList pay={pay} done={done} onSelect={onSelect} total={summary.payNow} />
        <div className="hidden overflow-x-auto rounded-[8px] border border-line bg-surface @[680px]:block">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">Документ</th>
                <th scope="col" className="px-3 py-2 font-medium">Поставщик</th>
                <th scope="col" className="px-3 py-2 font-medium">Счёт</th>
                <th scope="col" className="px-3 py-2 font-medium">Заказ</th>
                <th scope="col" className="px-3 py-2 font-medium">Основание</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {pay.map((r) => (
                <tr key={r.id} className="border-b border-line align-top last:border-b-0 hover:bg-surface-2/60">
                  <td className="num px-3 py-2">
                    <button onClick={() => onSelect(r.id)} className="font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                      {r.id}
                    </button>
                    {done.has(r.id) && <Check className="ml-1 inline size-3.5 text-pay" aria-label="подтверждено" />}
                  </td>
                  <td className="px-3 py-2 text-ink">{r.supplier}</td>
                  <td className="num px-3 py-2">{r.ex.invoiceNo}</td>
                  <td className="num px-3 py-2">{r.orderId}</td>
                  <td className="max-w-[320px] px-3 py-2 text-[12.5px] text-muted-foreground">{r.findings.find((f) => f.level === "info")?.text ?? "заказ, приёмка и цена сходятся"}</td>
                  <td className="num px-3 py-2 text-right font-medium text-ink">{fmtRub(r.payNow)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line-strong bg-surface-2">
                <td colSpan={5} className="px-3 py-2.5 font-semibold text-ink">
                  Итого к оплате · {pay.length} {plural(pay.length, INVOICES)}
                </td>
                <td className="num px-3 py-2.5 text-right text-[15px] font-semibold text-ink">{fmtRub(summary.payNow)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section aria-labelledby="held-h">
        <h2 id="held-h" className="mb-1 text-[17px] font-semibold text-ink">
          Не включено в реестр
        </h2>
        <p className="mb-3 text-[13px] text-muted-foreground">Ждёт ответа, исправления или остановлено. Дубли в реестр не попадают и здесь не показаны.</p>
        <HeldList held={held} onSelect={onSelect} />
        <div className="hidden overflow-x-auto rounded-[8px] border border-line bg-surface @[680px]:block">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">Документ</th>
                <th scope="col" className="px-3 py-2 font-medium">Вердикт</th>
                <th scope="col" className="px-3 py-2 font-medium">Причина</th>
                <th scope="col" className="px-3 py-2 font-medium">Ждём ответа</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">По счёту</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">По сверке</th>
              </tr>
            </thead>
            <tbody>
              {held.map((r) => (
                <tr key={r.id} className="border-b border-line align-top last:border-b-0 hover:bg-surface-2/60">
                  <td className="num px-3 py-2">
                    <button onClick={() => onSelect(r.id)} className="font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                      {r.id}
                    </button>
                    <div className="text-[12px] text-muted-foreground">{r.supplier}</div>
                  </td>
                  <td className="px-3 py-2">
                    <VerdictTag v={r.verdict} />
                  </td>
                  <td className="max-w-[340px] px-3 py-2 text-[12.5px] text-ink">{r.headline}</td>
                  <td className="px-3 py-2 text-[12.5px] text-muted-foreground">{r.addressees.map((a) => a.name).join(", ")}</td>
                  <td className="num px-3 py-2 text-right text-muted-foreground">{fmtRub(r.invoiced)}</td>
                  <td className={cn("num px-3 py-2 text-right", r.due !== r.invoiced ? "font-medium text-ink" : "text-muted-foreground")}>{fmtRub(r.due)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// Узкая область: списки вместо таблиц, без горизонтальной прокрутки.
function PayList({ pay, done, onSelect, total }: { pay: Result[]; done: Set<string>; onSelect: (id: string) => void; total: number }) {
  return (
    <ul className="divide-y divide-line rounded-[8px] border border-line bg-surface @[680px]:hidden">
      {pay.map((r) => (
        <li key={r.id}>
          <button onClick={() => onSelect(r.id)} className="grid w-full grid-cols-[1fr_auto] gap-x-3 px-3 py-2.5 text-left hover:bg-surface-2/60">
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="num text-[12px] font-semibold text-muted-foreground">{r.id}</span>
                <span className="truncate font-medium text-ink">{r.supplier}</span>
                {done.has(r.id) && <Check className="size-3.5 shrink-0 text-pay" aria-label="подтверждено" />}
              </span>
              <span className="num block text-[12.5px] text-muted-foreground">
                счёт {r.ex.invoiceNo} · {r.orderId}
              </span>
            </span>
            <span className="num self-center font-medium text-ink">{fmtRub(r.payNow)}</span>
          </button>
        </li>
      ))}
      <li className="flex items-baseline justify-between bg-surface-2 px-3 py-2.5 font-semibold text-ink">
        <span>Итого · {pay.length}</span>
        <span className="num text-[15px]">{fmtRub(total)}</span>
      </li>
    </ul>
  );
}

function HeldList({ held, onSelect }: { held: Result[]; onSelect: (id: string) => void }) {
  return (
    <ul className="divide-y divide-line rounded-[8px] border border-line bg-surface @[680px]:hidden">
      {held.map((r) => (
        <li key={r.id}>
          <button onClick={() => onSelect(r.id)} className="flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-surface-2/60">
            <span className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="num text-[12px] font-semibold text-muted-foreground">{r.id}</span>
                <span className="truncate font-medium text-ink">{r.supplier}</span>
              </span>
              <VerdictTag v={r.verdict} />
            </span>
            <span className="text-[12.5px] leading-snug text-ink">{r.headline}</span>
            <span className="num flex flex-wrap justify-between gap-x-3 text-[12px] text-muted-foreground">
              <span>{r.addressees.map((a) => a.name).join(", ")}</span>
              <span>
                {fmtRub(r.invoiced)} → <span className="font-medium text-ink">{fmtRub(r.due)}</span>
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
