import { useState } from "react";
import { BadgeCheck, Check, ChevronDown, Download, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INVOICES, cn, plural } from "@/lib/utils";
import type { Result } from "@/core/types";
import { DECISION_LABEL, type DocStatus, type RegistryItem, type RegistryState } from "@/core/events";
import { VerdictTag, fmtRub } from "./verdict";
import { Sep } from "@/components/sep";
import { fmtAt } from "@/components/DecisionPanel";

function csv(rows: (string | number)[][]) {
  return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
}

const basisText = (i: RegistryItem) =>
  i.basis === "сверка" ? (i.r.findings.find((f) => f.level === "info")?.text ?? "заказ, приёмка и цена сходятся") : `Решение бухгалтера: ${i.reason}`;

// «Не включено»: группы по причине, в порядке срочности
type HeldGroup = "stop" | "requisites" | "accepted" | "approval" | "return" | "rejected" | "other";
const HELD: Record<HeldGroup, { label: string; hint: string }> = {
  stop: {
    label: "Остановлено: признаки подмены",
    hint: "Платить нельзя, передать финансовому директору и закупщику",
  },
  requisites: {
    label: "Платёж задержан: смена реквизитов",
    hint: "Сверка пройдена, но нужно подписанное допсоглашение в Directum RX",
  },
  accepted: {
    label: "Больше, чем принято на складе",
    hint: "Ждём приёмку или условия договора о предоплате от закупщика",
  },
  approval: {
    label: "Цена или количество без согласования",
    hint: "Ждём подписанное согласование в Directum RX или исправленный счёт",
  },
  return: {
    label: "Вернуть поставщику на исправление",
    hint: "Ошибка в счёте, ждём исправленную версию",
  },
  rejected: {
    label: "Не платить по решению бухгалтера",
    hint: "Причина записана в карточке счёта",
  },
  other: { label: "Ждёт ответа", hint: "Вопрос отправлен" },
};
const ORDER = Object.keys(HELD) as HeldGroup[];

function heldGroup(r: Result, s: DocStatus | undefined): HeldGroup {
  if (s?.valid && s.decision?.kind === "reject") return "rejected";
  if (r.verdict === "stop") return "stop";
  if (r.verdict === "return") return "return";
  const rules = r.findings.filter((f) => f.level !== "info").map((f) => f.rule);
  if (rules.includes("П-2")) return "requisites";
  if (rules.includes("П-4") || rules.includes("П-5")) return "accepted";
  if (rules.includes("П-6")) return "approval";
  return "other";
}

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

export function Registry({
  results,
  statuses,
  registry,
  onSelect,
  snapshot,
  onSubmit,
  onApprove,
}: {
  results: Result[];
  statuses: Map<string, DocStatus>;
  registry: RegistryState;
  onSelect: (id: string) => void;
  snapshot: string;
  onSubmit: () => void;
  onApprove: () => void;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  // свёрнутые группы «Не включено»: запоминаются между перезагрузками
  const [folded, setFolded] = useState<Set<HeldGroup>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("sy.regFolded") ?? "[]") as HeldGroup[]);
    } catch {
      return new Set();
    }
  });
  const fold = (next: Set<HeldGroup>) => {
    setFolded(next);
    try {
      localStorage.setItem("sy.regFolded", JSON.stringify([...next]));
    } catch {
      /* хранилище недоступно: работаем без него */
    }
  };
  const toggle = (g: HeldGroup) => {
    const next = new Set(folded);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    fold(next);
  };
  const { items, total, unconfirmed, status } = registry;
  const inReg = new Set(items.map((i) => i.r.id));
  // на сколько к оплате меньше, чем по счёту (например, платим только за принятое)
  const cut = (i: RegistryItem) => Math.max(0, Math.round(((i.r.invoiced ?? 0) - i.amount) * 100) / 100);
  const unc = new Set(unconfirmed.map((r) => r.id));
  // не вошли: счета не в реестре и не «ждут подтверждения»; дубли не показываем (они на плитке «Не платить»)
  const held = results.filter((r) => r.ex.kind !== "letter" && r.verdict !== "duplicate" && !inReg.has(r.id) && !unc.has(r.id));
  const groups = ORDER.map((g) => ({
    g,
    rs: held.filter((r) => heldGroup(r, statuses.get(r.id)) === g),
  })).filter((x) => x.rs.length);

  const download = () => {
    const rows: (string | number)[][] = [["Документ", "Поставщик", "Счёт", "Заказ", "Основание", "По счёту, руб.", "К оплате, руб."]];
    for (const i of items)
      rows.push([
        i.r.id,
        i.r.supplier ?? "",
        i.r.ex.invoiceNo ?? "",
        i.r.orderId ?? "",
        i.basis === "сверка" ? "сверка" : `решение бухгалтера: ${i.reason}`,
        i.r.invoiced ?? "",
        i.amount,
      ]);
    rows.push(["", "", "", "", "Итого", sum(items.map((i) => i.r.invoiced ?? 0)), total]);
    const blob = new Blob(["﻿" + csv(rows)], {
      type: "text/csv;charset=utf-8",
    });
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
              На утверждение финансовому директору (П-9)
              <Sep />
              срез {snapshot}
              <Sep />в реестр попадают только счета, подтверждённые бухгалтером
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={download}>
            <Download />
            Скачать CSV
          </Button>
        </div>

        {/* Статус реестра: черновик → передан ФД → утверждён */}
        <div
          className={cn(
            "mb-3 flex flex-wrap items-center justify-between gap-3 rounded-[8px] border px-4 py-3",
            status === "approved" ? "border-pay/40 bg-pay/[0.07]" : status === "submitted" ? "border-line-strong bg-surface-2" : "border-line bg-surface",
          )}
        >
          <div className="text-[13.5px] text-ink">
            {status === "draft" && (
              <>
                <span className="font-semibold">Черновик</span>
                <Sep />
                {items.length} {plural(items.length, INVOICES)} на {fmtRub(total)}
                {unconfirmed.length > 0 && (
                  <>
                    <Sep />
                    <span className="text-muted-foreground">ещё {unconfirmed.length} ждут подтверждения</span>
                  </>
                )}
                {registry.changedAfterSubmit && <p className="mt-0.5 text-[12.5px] text-ask">Реестр изменился после передачи ФД. Передайте заново.</p>}
              </>
            )}
            {status === "submitted" && (
              <>
                <span className="font-semibold">Передан на утверждение ФД</span>
                <Sep />
                {fmtAt(registry.submittedAt)}
                <p className="mt-0.5 text-[12.5px] text-muted-foreground">В продукте ФД утверждает в своей учётной записи. Для показа кнопка здесь.</p>
              </>
            )}
            {status === "approved" && (
              <span className="inline-flex items-center gap-1.5 font-semibold text-pay">
                <BadgeCheck className="size-4" aria-hidden />
                Утверждён ФД
                <Sep />
                <span className="font-normal text-ink">{fmtAt(registry.approvedAt)}</span>
              </span>
            )}
          </div>
          {status === "draft" && (
            <Button size="sm" onClick={() => (items.length ? (onSubmit(), setMsg(null)) : setMsg("В реестре пока нет подтверждённых счетов."))}>
              <Send />
              Передать на утверждение ФД
            </Button>
          )}
          {status === "submitted" && (
            <Button size="sm" onClick={onApprove}>
              <BadgeCheck />
              Утвердить (за ФД)
            </Button>
          )}
        </div>
        {msg && <p className="-mt-1 mb-3 text-[13px] text-stop">{msg}</p>}

        {items.length === 0 ? (
          <p className="rounded-[8px] border border-dashed border-line-strong bg-surface px-4 py-6 text-center text-[13.5px] text-muted-foreground">
            Подтвердите счета «к оплате» в карточках: в реестр попадает только то, что проверил бухгалтер.
          </p>
        ) : (
          <>
            <ul className="divide-y divide-line rounded-[8px] border border-line bg-surface @[680px]:hidden">
              {items.map((i) => (
                <li key={i.r.id}>
                  <button onClick={() => onSelect(i.r.id)} className="grid w-full grid-cols-[1fr_auto] gap-x-3 px-3 py-2.5 text-left hover:bg-surface-2/60">
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="num text-[12px] font-semibold text-muted-foreground">{i.r.id}</span>
                        <span className="truncate font-medium text-ink">{i.r.supplier}</span>
                      </span>
                      <span className="num block text-[12.5px] text-muted-foreground">
                        счёт {i.r.ex.invoiceNo}
                        <Sep />
                        {i.r.orderId}
                        {i.basis !== "сверка" && (
                          <>
                            <Sep />
                            решение бухгалтера
                          </>
                        )}
                      </span>
                    </span>
                    <span className="num flex flex-col items-end self-center">
                      <span className="font-medium text-ink">{fmtRub(i.amount)}</span>
                      {cut(i) > 0 && <span className="text-[12px] text-muted-foreground">из {fmtRub(i.r.invoiced)}</span>}
                    </span>
                  </button>
                </li>
              ))}
              <li className="flex items-baseline justify-between bg-surface-2 px-3 py-2.5 font-semibold text-ink">
                <span>
                  Итого
                  <Sep />
                  {items.length}
                </span>
                <span className="num text-[15px]">{fmtRub(total)}</span>
              </li>
            </ul>
            <div className="hidden overflow-x-auto rounded-[8px] border border-line bg-surface @[680px]:block">
              <table className="w-full border-collapse text-[13.5px]">
                <thead>
                  <tr className="border-b border-line text-left text-[12px] text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Документ
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Поставщик
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Счёт
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Заказ
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Основание
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      По счёту
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      К оплате
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.r.id} className="border-b border-line align-top last:border-b-0 hover:bg-surface-2/60">
                      <td className="num px-3 py-2">
                        <button onClick={() => onSelect(i.r.id)} className="font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                          {i.r.id}
                        </button>
                        <Check className="ml-1 inline size-3.5 text-pay" aria-label="подтверждено" />
                      </td>
                      <td className="px-3 py-2 text-ink">{i.r.supplier}</td>
                      <td className="num px-3 py-2">{i.r.ex.invoiceNo}</td>
                      <td className="num px-3 py-2">{i.r.orderId}</td>
                      <td className={cn("max-w-[320px] px-3 py-2 text-[12.5px]", i.basis === "сверка" ? "text-muted-foreground" : "text-ink")}>{basisText(i)}</td>
                      <td className={cn("num px-3 py-2 text-right", "text-muted-foreground")}>{fmtRub(i.r.invoiced)}</td>
                      <td className="num px-3 py-2 text-right font-medium text-ink">
                        {fmtRub(i.amount)}
                        {cut(i) > 0 && <span className="block text-[12px] font-normal text-muted-foreground">меньше на {fmtRub(cut(i))}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-line-strong bg-surface-2">
                    <td colSpan={5} className="px-3 py-2.5 font-semibold text-ink">
                      Итого к оплате
                      <Sep />
                      {items.length} {plural(items.length, INVOICES)}
                    </td>
                    <td className="num px-3 py-2.5 text-right text-muted-foreground">{fmtRub(sum(items.map((i) => i.r.invoiced ?? 0)))}</td>
                    <td className="num px-3 py-2.5 text-right text-[15px] font-semibold text-ink">{fmtRub(total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </section>

      {unconfirmed.length > 0 && (
        <section aria-labelledby="unc-h">
          <h2 id="unc-h" className="mb-1 text-[17px] font-semibold text-ink">
            Сверка пройдена, ждут подтверждения
          </h2>
          <p className="mb-3 text-[13px] text-muted-foreground">
            Сверка предлагает к оплате {fmtRub(registry.proposed.total)}. Откройте счёт и подтвердите, чтобы он попал в реестр.
          </p>
          <ul className="divide-y divide-line rounded-[8px] border border-line bg-surface">
            {unconfirmed.map((r) => (
              <li key={r.id}>
                <button onClick={() => onSelect(r.id)} className="grid w-full grid-cols-[1fr_auto] gap-x-3 px-3 py-2.5 text-left hover:bg-surface-2/60">
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="num text-[12px] font-semibold text-muted-foreground">{r.id}</span>
                      <span className="truncate font-medium text-ink">{r.supplier}</span>
                    </span>
                    <span className="block text-[12.5px] text-muted-foreground">{statuses.get(r.id)?.stale ?? r.headline}</span>
                  </span>
                  <span className="num self-center font-medium text-ink">{fmtRub(r.payNow)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="held-h">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h2 id="held-h" className="text-[17px] font-semibold text-ink">
            Не включено в реестр
          </h2>
          {groups.length > 1 && (
            <Button size="sm" variant="ghost" onClick={() => fold(groups.every(({ g }) => folded.has(g)) ? new Set() : new Set(groups.map(({ g }) => g)))}>
              {groups.every(({ g }) => folded.has(g)) ? "Развернуть все" : "Свернуть все"}
            </Button>
          )}
        </div>
        <p className="mb-3 text-[13px] text-muted-foreground">
          {held.length ? "Сгруппировано по причине: чего ждём и от кого. Дубли сюда не входят." : "Все счета в реестре или ждут подтверждения."}
        </p>
        <div className="flex flex-col gap-2">
          {groups.map(({ g, rs }) => (
            <div key={g} className={cn(!folded.has(g) && "mb-2")}>
              <h3>
                <button
                  onClick={() => toggle(g)}
                  aria-expanded={!folded.has(g)}
                  className="grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-x-2 rounded-[6px] px-3 py-1.5 text-left hover:bg-surface-2/60"
                >
                  <ChevronDown className={cn("size-4 translate-y-[3px] text-muted-foreground transition-transform duration-200", folded.has(g) && "-rotate-90")} aria-hidden />
                  <span className="text-[14px] font-semibold text-ink">
                    {HELD[g].label}
                    <span className="font-normal text-muted-foreground">
                      <Sep />
                      {rs.length} {plural(rs.length, INVOICES)}
                    </span>
                  </span>
                  <span className="num text-[13px] font-medium text-ink">{fmtRub(sum(rs.map((r) => r.invoiced ?? 0)))}</span>
                  {!folded.has(g) && <span className="col-start-2 col-end-4 text-[12.5px] font-normal text-muted-foreground">{HELD[g].hint}</span>}
                </button>
              </h3>
              <ul hidden={folded.has(g)} className="mt-1 divide-y divide-line rounded-[8px] border border-line bg-surface">
                {rs.map((r) => {
                  const s = statuses.get(r.id);
                  return (
                    <li key={r.id}>
                      <button onClick={() => onSelect(r.id)} className="flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-surface-2/60">
                        <span className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="num text-[12px] font-semibold text-muted-foreground">{r.id}</span>
                            <span className="truncate font-medium text-ink">{r.supplier}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {s?.valid && s.decision && <span className="text-[12px] text-muted-foreground">{DECISION_LABEL[s.decision.kind].toLowerCase()}</span>}
                            <VerdictTag v={r.verdict} />
                          </span>
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
                  );
                })}
              </ul>
            </div>
          ))}
          {held.length > 0 && (
            <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 rounded-[8px] bg-surface-2 px-3 py-2.5 font-semibold text-ink">
              <span>
                Итого не включено<Sep />
                {held.length} {plural(held.length, INVOICES)}
              </span>
              <span className="num text-[15px]">{fmtRub(sum(held.map((r) => r.invoiced ?? 0)))}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
