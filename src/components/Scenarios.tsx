import { useState, type ReactNode } from "react";
import { FileCheck2, Mail, RotateCcw, Sparkles, Trash2, Undo2, Warehouse } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EVENT_SOURCE, describeEvent, type AppEvent } from "@/core/events";
import type { Verdict } from "@/core/types";
import { SCENARIOS, type Scenario } from "@/data/scenarios";
import { DEMO_LETTERS } from "@/data/demo-letters";
import { VERDICT } from "./verdict";
import { fmtAt } from "./DecisionPanel";
import { Sep } from "@/components/sep";

type Change = { id: string; from: Verdict; to: Verdict };

const sameEvent = (e: AppEvent, sc: Scenario) =>
  e.type === sc.event.type && (e.type === "acceptance" ? sc.event.type === "acceptance" && e.order === sc.event.order : e.type === "approval-signed" && sc.event.type === "approval-signed" && e.approval === sc.event.approval);

/** Раздел для жюри: события из учётных систем, демо-письма одним нажатием, журнал, отмена и сброс. */
export function Scenarios({
  form,
  events,
  preview,
  onRun,
  onLetter,
  onUndo,
  onRemove,
  onReset,
  onSelect,
}: {
  form: ReactNode; // своё письмо: первый блок
  events: AppEvent[];
  preview: (body: Scenario["event"]) => Change[];
  onRun: (sc: Scenario) => void;
  onLetter: (sender: string, text: string) => Promise<void>;
  onUndo: () => void;
  onRemove: (id: string) => void;
  onReset: () => void;
  onSelect: (id: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const changeText = (c: Change) => `${c.id}: ${VERDICT[c.from].label.toLowerCase()} → ${VERDICT[c.to].label.toLowerCase()}`;

  return (
    <div className="mx-auto flex max-w-[1080px] flex-col gap-8 px-4 pt-6 pb-12 sm:px-6">
      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="max-w-[640px]">
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Проверить пилот</h1>
            <p className="mt-1 text-[13.5px] text-muted-foreground text-pretty">
              Всё, что меняет данные, это событие: письмо, приёмка, подпись, решение бухгалтера. После каждого события очередь пересчитывается, а на плитках сверху появляется
              разница. В продукте письма придут из почты, приёмка из 1С:ERP, подписи из Directum RX; здесь это имитация. Состояние хранится только в этом браузере.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onUndo} disabled={!events.length}>
              <Undo2 />
              Отменить последнее
            </Button>
            {/* кнопка не меняется при подтверждении: вопрос появляется отдельной строкой ниже, ничего не сдвигается под курсором */}
            <Button size="sm" variant="outline" onClick={() => setConfirmReset(!confirmReset)} disabled={!events.length} aria-expanded={confirmReset}>
              <RotateCcw />
              Сбросить демо
            </Button>
          </div>
        </div>
        {confirmReset && events.length > 0 && (
          <div role="alertdialog" aria-label="Сбросить демо" className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[8px] border border-stop/40 bg-stop/[0.06] px-4 py-3">
            <p className="text-[13.5px] text-ink">
              Удалить все события ({events.length}) и вернуть данные к выгрузке кейса? Отменить сброс нельзя.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                Нет
              </Button>
              <Button size="sm" variant="destructive" onClick={() => (onReset(), setConfirmReset(false))}>
                Да, сбросить
              </Button>
            </div>
          </div>
        )}
      </section>

      {form}

      <section aria-labelledby="sc-sys">
        <h2 id="sc-sys" className="text-[17px] font-semibold text-ink">
          События из учётных систем
        </h2>
        <p className="mb-3 text-[13px] text-muted-foreground">В пилоте это симуляция. В продукте приёмка придёт из 1С:ERP, подпись согласования из Directum RX.</p>
        <ul className="grid gap-3 @container sm:grid-cols-2 lg:grid-cols-3">
          {SCENARIOS.map((sc) => {
            const applied = events.find((e) => sameEvent(e, sc));
            const ch = applied ? [] : preview(sc.event);
            const Icon = sc.event.type === "acceptance" ? Warehouse : FileCheck2;
            return (
              <li key={sc.id} className={cn("flex flex-col gap-2 rounded-[8px] border bg-surface p-3.5", applied ? "border-pay/40" : "border-line")}>
                <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <Icon className="size-3.5" aria-hidden />
                  {EVENT_SOURCE[sc.event.type]}
                  <Sep />
                  симуляция
                </p>
                <p className="text-[14px] font-semibold leading-snug text-ink">{sc.title}</p>
                <p className="text-[12.5px] leading-snug text-muted-foreground">{sc.why}</p>
                {!applied && ch.length > 0 && (
                  <p className="text-[12.5px] text-ink">
                    <span className="text-muted-foreground">Что изменится: </span>
                    {ch.map(changeText).join(", ")}
                  </p>
                )}
                <div className="mt-auto flex items-center gap-2 pt-1">
                  {applied ? (
                    <>
                      <span className="text-[12.5px] font-medium text-pay">Применено {fmtAt(applied.at)}</span>
                      <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onRemove(applied.id)}>
                        Убрать
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => onRun(sc)}>
                      Применить
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="sc-mail">
        <h2 id="sc-mail" className="text-[17px] font-semibold text-ink">
          Письма
        </h2>
        <p className="mb-3 text-[13px] text-muted-foreground">Письмо попадает в очередь, как будто пришло на общий ящик. Своё письмо вставьте в форму выше.</p>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {DEMO_LETTERS.map((d) => (
            <li key={d.id} className="flex flex-col gap-1.5 rounded-[8px] border border-line bg-surface p-3.5">
              <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Mail className="size-3.5" aria-hidden />
                почта
                {d.ai && (
                  <>
                    <Sep />
                    <span className="inline-flex items-center gap-0.5 text-accent">
                      <Sparkles className="size-3" aria-hidden />с ИИ
                    </span>
                  </>
                )}
              </p>
              <p className="text-[14px] font-semibold leading-snug text-ink">{d.title}</p>
              <p className="text-[12.5px] leading-snug text-muted-foreground">{d.shows}</p>
              <div className="mt-auto pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(d.id);
                    try {
                      await onLetter(d.sender, d.text);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === d.id ? "Проверяю…" : "Отправить в очередь"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="sc-log">
        <h2 id="sc-log" className="mb-1 text-[17px] font-semibold text-ink">
          Журнал событий
        </h2>
        <p className="mb-3 text-[13px] text-muted-foreground">По порядку. Любое событие можно убрать: очередь пересчитается без него. В продукте это журнал действий в базе.</p>
        {events.length === 0 ? (
          <p className="rounded-[8px] border border-dashed border-line-strong bg-surface px-4 py-5 text-center text-[13.5px] text-muted-foreground">Журнал пуст: очередь построена по исходной выгрузке кейса.</p>
        ) : (
          <ol className="divide-y divide-line rounded-[8px] border border-line bg-surface">
            {events.map((e) => {
              const doc = e.type === "letter" ? e.letter.id : e.type === "decision" || e.type === "reopen" ? e.doc : null;
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
                  <span className="num w-[86px] shrink-0 text-muted-foreground">{fmtAt(e.at)}</span>
                  <span className="w-[130px] shrink-0 text-muted-foreground">{EVENT_SOURCE[e.type]}</span>
                  <span className="min-w-0 flex-1 text-ink">
                    {doc ? (
                      <button onClick={() => onSelect(doc)} className="underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                        {describeEvent(e)}
                      </button>
                    ) : (
                      describeEvent(e)
                    )}
                  </span>
                  <button onClick={() => onRemove(e.id)} className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-surface-2 hover:text-ink" aria-label={`Убрать: ${describeEvent(e)}`}>
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
