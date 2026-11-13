import type { TimelineItem } from "@/core/events";
import { cn } from "@/lib/utils";
import { VerdictTag } from "./verdict";
import { Sep } from "@/components/sep";

/** История заказа в карточке: заказ, согласования, приёмка, счета и письма: по дате; события журнала: в конце. */
export function OrderTimeline({ orderId, items, currentId, onSelect }: { orderId: string; items: TimelineItem[]; currentId: string; onSelect: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <section aria-labelledby="hist-h">
      <h2 id="hist-h" className="mb-2 text-[15px] font-semibold text-ink">
        История заказа {orderId}
      </h2>
      <ol className="rounded-[8px] border border-line bg-surface px-4 py-2">
        {items.map((it, i) => {
          const current = it.docId === currentId;
          return (
            <li key={it.key} className={cn("relative grid grid-cols-[64px_14px_minmax(0,1fr)] gap-x-2 py-1.5 text-[13px]", current && "-mx-2 rounded-[6px] bg-hl/50 px-2")}>
              <span className="num pt-px text-[12px] text-muted-foreground">{it.when}</span>
              {/* точка и линия между событиями */}
              <span className="relative flex justify-center" aria-hidden>
                {i < items.length - 1 && <span className="absolute top-3 -bottom-3 w-px bg-line" />}
                <span className={cn("relative mt-1 size-2.5 rounded-full border-2 bg-surface", it.simulated ? "border-accent" : current ? "border-ink" : "border-line-strong")} />
              </span>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  {it.docId && !current ? (
                    <button onClick={() => onSelect(it.docId!)} className="text-left text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                      {it.text}
                    </button>
                  ) : (
                    <span className={cn("text-ink", current && "font-semibold")}>
                      {it.text}
                      {current && <span className="font-normal text-muted-foreground"> (этот документ)</span>}
                    </span>
                  )}
                  {it.verdict && <VerdictTag v={it.verdict} />}
                </span>
                <span className="block text-[12px] text-muted-foreground">
                  {it.source}
                  {it.simulated && it.source !== "почта" && (
                    <>
                      <Sep />
                      симуляция
                    </>
                  )}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
