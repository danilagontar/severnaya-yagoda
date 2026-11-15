import { useState } from "react";
import { Check, CircleSlash, Clock, RotateCcw, Send, Undo2, Wallet } from "lucide-react";
import { roleTitle } from "@/core/drafts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DECISION_LABEL, WAIT_LIMIT_DAYS, askOptions, atLabel, waitingDays, type Decision, type DocStatus } from "@/core/events";
import type { Addressee, Result } from "@/core/types";
import { fmtRub } from "./verdict";
import { Sep } from "@/components/sep";
import { cn } from "@/lib/utils";

export const fmtAt = atLabel;

const HINT: Partial<Record<Result["verdict"], string>> = {
  pay: "Сверка пройдена. В реестр счёт попадёт только после подтверждения.",
  ask: "",
  return: "Поставщик пришлёт исправленный счёт, и он заменит этот.",
  stop: "По П-2 решение принимают закупщик и финансовый директор: отметьте, что передали обоим. Без подписанного допсоглашения оплатить нельзя.",
};

// адресат без имени («Финансовый директор», «Отдел закупок»): достаточно должности
const GENERIC = /^(Финансовый директор|Начальник склада|Казначей|Отдел закупок)$/;
const cap = (x: string) => x[0].toUpperCase() + x.slice(1);

/** Решение бухгалтера по документу: подтвердить, отметить отправленный вопрос, передать стоп, оплатить по решению, вернуть, не платить. */
export function DecisionPanel({
  r,
  status,
  onDecide,
}: {
  r: Result;
  status: DocStatus;
  onDecide: (d: Decision | null) => string | null;
}) {
  const [form, setForm] = useState<null | "override" | "reject">(null);
  // П-5: по договору обычно предоплата всего счёта, а не только принятой части; доплата к оплаченной версии: разница
  const contract = r.findings.some((f) => f.level === "ask" && f.rule === "П-5");
  const [amount, setAmount] = useState(String(contract ? r.invoiced ?? "" : r.due && r.due > 0 ? r.due : r.invoiced ?? ""));
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (r.verdict === "duplicate" || r.verdict === "letter") return null;

  // кому задают вопрос или передают стоп: адресаты из «Кому написать»
  const people = r.addressees.length ? [...new Map(r.addressees.map((a) => [a.name, a])).values()] : [{ role: "procurement", name: "Отдел закупок", reason: "" } as Addressee];
  const label = (a: Addressee) => (GENERIC.test(a.name) ? cap(roleTitle(a)) : `${a.name}, ${roleTitle(a)}`);
  const act = (d: Decision | null) => {
    const e = onDecide(d);
    setErr(e);
    if (!e) {
      setForm(null);
      setReason("");
    }
  };
  // отметки по адресатам: «вопрос отправлен» (вопрос) и «передано» (стоп)
  // вопрос задают, только если есть кому: подсказку ИИ и непрочитанный итог бухгалтер проверяет сам по письму
  const markKind = r.verdict === "ask" ? (r.addressees.length ? "waiting" : null) : r.verdict === "stop" ? "escalated" : null;
  const totalUnread = r.findings.some((f) => f.level === "ask" && f.rule === "П-8");
  const sent = status.decision?.kind === markKind && !status.stale ? status.sent : [];
  const toggle = (name: string) => {
    const who = sent.includes(name) ? sent.filter((n) => n !== name) : [...sent, name];
    if (!who.length) return act(null);
    act(markKind === "waiting" ? { kind: "waiting", who } : { kind: "escalated", who });
  };
  const d = status.valid ? status.decision : null;
  const opt = askOptions(r);
  const askRules = new Set(r.findings.filter((f) => f.level === "ask").map((f) => f.rule));
  const askHint =
    r.verdict !== "ask"
      ? ""
      : !r.addressees.length && r.aiPending.length
        ? "Спрашивать никого не нужно: подтвердите или исправьте значение от ИИ в сверке выше, и счёт пересчитается."
      : !r.addressees.length && totalUnread
        ? "Спрашивать никого не нужно: сверьте итог по тексту письма. Если он неверный, верните счёт поставщику (П-8)."
      : r.findings.some((f) => f.tag === "paid-before")
        ? (r.due ?? 0) > 0
          ? "Прежняя версия уже оплачена. Доплатить можно только разницу, по решению с причиной."
          : "Прежняя версия уже оплачена, доплачивать нечего. Если поставщик отзывает счёт, отметьте «Не платить»."
      : askRules.has("П-2")
        ? "По П-2 решение по реквизитам за закупщиком и ФД: отметьте, что вопрос им передан."
        : askRules.has("П-5")
          ? opt.override && status.waiting
            ? "Когда закупщик сообщит условия договора, оплатите по ним, например при предоплате, и укажите их в причине."
            : "По П-5 без условий договора нельзя ни отказать, ни оплатить. Сначала узнайте условия у закупщика и отметьте, что вопрос отправлен."
          : askRules.has("П-6")
            ? "Цена и количество действуют по заказу, пока нет подписанного согласования в Directum RX (П-6). Когда его подпишут, счёт пересчитается сам."
            : "";
  const final = d && d.kind !== "waiting" ? d : null; // окончательное решение: показываем итог вместо кнопок
  const days = status.waiting || (final?.kind === "returned" && !status.paid) ? waitingDays(status.at) : 0;

  const buttons: { label: string; icon: typeof Check; primary?: boolean; opens?: "override" | "reject"; run: () => void }[] = [];
  const reject = { label: "Не платить", icon: CircleSlash, opens: "reject" as const, run: () => (setForm("reject"), setErr(null)) };
  const override = { label: "Оплатить по решению", icon: Wallet, opens: "override" as const, run: () => (setForm("override"), setErr(null)) };
  if (r.verdict === "pay") buttons.push({ label: "Подтвердить в реестр", icon: Check, primary: true, run: () => act({ kind: "confirm", amount: r.payNow }) }, reject);
  // по «вопросу» ручные решения зависят от правила, по которому счёт задержан (askOptions)
  if (r.verdict === "ask") {
    // итог не прочитан: если по письму он неверный, счёт возвращают поставщику (П-8)
    if (totalUnread) buttons.push({ label: "Возвращено поставщику", icon: Undo2, run: () => act({ kind: "returned" }) });
    // П-5: условия договора сначала запрашивают у закупщика, оплата по решению только после вопроса
    if (opt.override && (!contract || status.waiting)) buttons.push(override);
    if (opt.reject) buttons.push(reject);
  }
  if (r.verdict === "return") buttons.push({ label: "Возвращено поставщику", icon: Undo2, primary: true, run: () => act({ kind: "returned" }) }, reject);

  return (
    <section aria-labelledby="dec-h" className="rounded-[8px] border border-line bg-surface p-4">
      <h2 id="dec-h" className="text-[15px] font-semibold text-ink">
        Решение бухгалтера
      </h2>

      {status.stale && <p className="mt-2 rounded-[6px] bg-ask/10 px-3 py-2 text-[13px] text-ink">{status.stale}</p>}

      {final ? (
        <div className="mt-2 text-[14px] text-ink">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="flex flex-wrap items-center gap-x-1.5 font-medium">
              {(status.inRegistry || status.paid) && <Check className="size-4 text-pay" aria-hidden />}
              {status.paid ? "Оплачено" : DECISION_LABEL[final.kind]}
              {(status.inRegistry || status.paid) && <span className="num text-pay">{fmtRub(status.amount)}</span>}
            </p>
            {/* рядом с решением, а не в углу блока: отмена там, где видно, что отменяешь; оплаченное не отменить */}
            {!status.paid && (
              <Button variant="outline" size="sm" onClick={() => act(null)}>
                <RotateCcw />
                Вернуть в работу
              </Button>
            )}
          </div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {final.kind === "escalated" && status.sent.length > 0 && <>Кому: {status.sent.join(", ")}<Sep /></>}
            {(final.kind === "pay-override" || final.kind === "reject") && final.reason && <>Причина: {final.reason}<Sep /></>}
            {status.paid ? <>платёж создан {fmtAt(status.paid.at)}</> : fmtAt(status.at)}
          </p>
          {final.kind === "returned" && !status.paid && (
            <p className={cn("mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px]", days >= WAIT_LIMIT_DAYS ? "font-medium text-ask" : "text-muted-foreground")}>
              <Clock className="size-3.5" aria-hidden />
              Ждём исправленный счёт {days ? `${days} дн.` : "с сегодня"}
              {days >= WAIT_LIMIT_DAYS && <><Sep />пора напомнить</>}
            </p>
          )}
        </div>
      ) : (
        <>
          {markKind && (
            <div className="mt-3">
              <p className="text-[13px] font-medium text-ink">{markKind === "waiting" ? "Вопрос отправлен" : "Передано по П-2"}</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {people.map((a) => {
                  const on = sent.includes(a.name);
                  return (
                    <Button key={a.name} size="sm" variant="outline" aria-pressed={on} className={cn(on && "border-pay/50 bg-pay/10 text-ink")} onClick={() => toggle(a.name)}>
                      {on ? <Check className="text-pay" /> : <Send />}
                      {label(a)}
                    </Button>
                  );
                })}
              </div>
              {markKind === "escalated" && sent.length > 0 && status.remaining.length > 0 && (
                <p className="mt-1.5 text-[12.5px] text-stop">Ещё нужно передать: {status.remaining.join(", ")}</p>
              )}
              {status.waiting && (
                <p className={cn("mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px]", days >= WAIT_LIMIT_DAYS ? "font-medium text-ask" : "text-muted-foreground")}>
                  <Clock className="size-3.5" aria-hidden />
                  Ждём ответа {days ? `${days} дн.` : "с сегодня"}
                  <Sep />
                  вопрос отправлен {fmtAt(status.at)}
                  {days >= WAIT_LIMIT_DAYS && <><Sep />пора напомнить</>}
                </p>
              )}
            </div>
          )}
          {buttons.length > 0 && <div className="mt-3 flex flex-wrap gap-2">
            {buttons.map((b) => (
              <Button
                key={b.label}
                size="sm"
                variant={b.primary ? "default" : "outline"}
                aria-pressed={b.opens ? form === b.opens : undefined}
                className={cn(b.opens && form === b.opens && "border-ink bg-surface-2")}
                onClick={b.opens && form === b.opens ? () => (setForm(null), setErr(null)) : b.run}
              >
                <b.icon />
                {b.label}
              </Button>
            ))}
          </div>}
          {!form && (HINT[r.verdict] || askHint) && <p className="mt-2 text-[12.5px] text-muted-foreground">{HINT[r.verdict] || askHint}</p>}
        </>
      )}

      {/* форма под кнопками, без своей рамки: только линия-разделитель */}
      {!final && form && (
        <form
          className="mt-3 flex flex-col gap-3 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (form === "override") act({ kind: "pay-override", amount: Number(amount.replace(/\s/g, "").replace(",", ".")), reason });
            else act({ kind: "reject", reason });
          }}
        >
          {form === "override" && (
            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-medium text-ink">Сумма к оплате, ₽</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => (setAmount(e.target.value), setErr(null))}
                className="num h-9 w-48 rounded-md border border-input bg-surface px-3 text-[14px] text-ink"
              />
              <span className="text-[12px] text-muted-foreground">Не больше суммы счёта ({fmtRub(r.invoiced)}). По сверке: {fmtRub(r.due)}.</span>
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[13px] font-medium text-ink">{form === "override" ? "На чём основано решение" : "Почему не платить"}</span>
            <Textarea
              value={reason}
              onChange={(e) => (setReason(e.target.value), setErr(null))}
              rows={2}
              placeholder={form === "override" ? "Договор № 14 предусматривает предоплату 100 %, подтвердил закупщик" : "Поставщик отозвал счёт"}
              className="text-[14px]"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit">
              {form === "override" ? "Добавить в реестр" : "Не платить"}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => (setForm(null), setErr(null))}>
              Отмена
            </Button>
          </div>
        </form>
      )}
      {err && <p className="mt-2 text-[13px] text-stop">{err}</p>}
    </section>
  );
}
