import { Link2 } from "lucide-react";
import type { TimelineItem } from "@/core/events";
import type { Result } from "@/core/types";
import { HIT, cn } from "@/lib/utils";
import { VERDICT, VerdictTag } from "./verdict";
import { Sep } from "@/components/sep";

/**
 * История заказа в карточке: заказ, согласования, приёмка, счета и письма по дате; события журнала в конце.
 * Под ней связанные документы, которых в истории нет (другой заказ, письмо без заказа). Если заказ не найден, остаются только они.
 */
export function OrderTimeline({
  orderId,
  items,
  currentId,
  onSelect,
  others = [],
}: {
  orderId: string | null;
  items: TimelineItem[];
  currentId: string;
  onSelect: (id: string) => void;
  others?: Result[];
}) {
  const hasHistory = !!orderId && items.length > 0;
  if (!hasHistory && !others.length) return null;
  const related = others.length > 0 && (
    <div className={cn("flex flex-wrap items-center gap-1.5 text-[13px]", hasHistory && "mt-2")}>
      <span className="mr-1 inline-flex items-center gap-1 text-muted-foreground">
        <Link2 className="size-3.5" aria-hidden />
        {hasHistory ? "Связано с другими заказами:" : "Связано:"}
      </span>
      {others.map((x) => (
        <button
          key={x.id}
          onClick={() => onSelect(x.id)}
          className="inline-flex items-center gap-1.5 rounded-[5px] border border-line bg-surface px-2 py-0.5 hover:border-line-strong"
          title={x.headline}
        >
          <span className="num font-medium">{x.id}</span>
          <span className="text-[12px] text-muted-foreground">{x.ex.kind === "letter" ? "письмо" : VERDICT[x.verdict].label.toLowerCase()}</span>
        </button>
      ))}
    </div>
  );
  if (!hasHistory)
    return (
      <section aria-labelledby="hist-h">
        <h2 id="hist-h" className="mb-2 text-[15px] font-semibold text-ink">
          Связанные документы
        </h2>
        {related}
      </section>
    );
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
                    <button onClick={() => onSelect(it.docId!)} className={cn(HIT, "text-left text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink")}>
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
      {related}
    </section>
  );
}
