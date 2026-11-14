import { useState } from "react";
import { Check, CircleSlash, Clock, RotateCcw, Send, Undo2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DECISION_LABEL, atLabel, type Decision, type DocStatus } from "@/core/events";
import type { Result } from "@/core/types";
import { fmtRub } from "./verdict";
import { Sep } from "@/components/sep";

export const fmtAt = atLabel;

const HINT: Partial<Record<Result["verdict"], string>> = {
  pay: "Сверка пройдена. В реестр счёт попадёт только после подтверждения.",
  ask: "Если закупщик оформит подписанное согласование в Directum RX, сверка пересчитается сама. «Оплатить по решению» только для того, что правилами не решается (например, предоплата по договору), с обязательной причиной.",
  return: "Ошибка в счёте: поставщик должен прислать исправленный. Исправленная версия заменит этот счёт.",
  stop: "Признаки подмены получателя: оплатить вручную нельзя.",
};

/** Решение бухгалтера по документу: подтвердить, ждать ответа, оплатить по решению, вернуть, не платить. */
export function DecisionPanel({ r, status, onDecide }: { r: Result; status: DocStatus; onDecide: (d: Decision | null) => string | null }) {
  const [form, setForm] = useState<null | "override" | "reject">(null);
  const [amount, setAmount] = useState(String(r.due && r.due > 0 ? r.due : r.invoiced ?? ""));
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (r.verdict === "duplicate" || r.verdict === "letter") return null;

  const who = [...new Set(r.addressees.map((a) => a.name))].join(", ") || "Отдел закупок";
  const act = (d: Decision | null) => {
    const e = onDecide(d);
    setErr(e);
    if (!e) {
      setForm(null);
      setReason("");
    }
  };
  const d = status.valid ? status.decision : null;

  const buttons: { label: string; icon: typeof Check; primary?: boolean; run: () => void }[] = [];
  const waiting = { label: "Вопрос отправлен, ждём ответа", icon: Send, run: () => act({ kind: "waiting", who }) };
  const reject = { label: "Не платить", icon: CircleSlash, run: () => (setForm("reject"), setErr(null)) };
  const override = { label: "Оплатить по решению", icon: Wallet, run: () => (setForm("override"), setErr(null)) };
  if (r.verdict === "pay") buttons.push({ label: "Подтвердить в реестр", icon: Check, primary: true, run: () => act({ kind: "confirm", amount: r.payNow }) }, reject);
  if (r.verdict === "ask") buttons.push({ ...waiting, primary: true }, override, reject);
  if (r.verdict === "return") buttons.push({ label: "Возвращено поставщику", icon: Undo2, primary: true, run: () => act({ kind: "returned" }) }, waiting, reject);
  if (r.verdict === "stop") buttons.push({ label: "Передано ФД и закупщику", icon: Send, primary: true, run: () => act({ kind: "escalated" }) }, waiting, reject);

  return (
    <section aria-labelledby="dec-h" className="rounded-[8px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="dec-h" className="text-[15px] font-semibold text-ink">
          Решение бухгалтера
        </h2>
        {d && (
          <Button variant="outline" size="sm" onClick={() => act(null)}>
            <RotateCcw />
            Вернуть в работу
          </Button>
        )}
      </div>

      {status.stale && <p className="mt-2 rounded-[6px] bg-ask/10 px-3 py-2 text-[13px] text-ink">{status.stale}</p>}

      {d ? (
        <div className="mt-2 text-[14px] text-ink">
          <p className="flex flex-wrap items-center gap-x-1.5 font-medium">
            {status.inRegistry ? <Check className="size-4 text-pay" aria-hidden /> : d.kind === "waiting" ? <Clock className="size-4 text-muted-foreground" aria-hidden /> : null}
            {DECISION_LABEL[d.kind]}
            {status.inRegistry && <span className="num text-pay">{fmtRub(status.amount)}</span>}
          </p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {d.kind === "waiting" && <>Кому: {d.who}<Sep /></>}
            {(d.kind === "pay-override" || d.kind === "reject") && d.reason && <>Причина: {d.reason}<Sep /></>}
            {fmtAt(status.at)}
          </p>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {buttons.map((b) => (
              <Button key={b.label} size="sm" variant={b.primary ? "default" : "outline"} onClick={b.run}>
                <b.icon />
                {b.label}
              </Button>
            ))}
          </div>
          {HINT[r.verdict] && <p className="mt-2 text-[12.5px] text-muted-foreground">{HINT[r.verdict]}</p>}
        </>
      )}

      {!d && form && (
        <form
          className="mt-3 flex flex-col gap-2 rounded-[6px] border border-line bg-surface-2 p-3"
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
              className="bg-surface text-[14px]"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit">
              {form === "override" ? "В реестр" : "Не платить"}
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
