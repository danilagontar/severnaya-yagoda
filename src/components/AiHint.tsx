// Подсказка ИИ в ячейке сверки: значение, которое прочитал только ИИ (или разборы разошлись).
// Пока бухгалтер не подтвердит или не исправит значение, счёт не уходит в оплату (reconcile.ts).
import { useState } from "react";
import { Check, CircleCheck, Pencil, Sparkles, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CrossField, FieldSource } from "@/core/types";

export type ConfirmField = (field: CrossField["key"], value: string, source: FieldSource | null) => void;

const NUMERIC = new Set<CrossField["key"]>(["qty", "price", "total"]);
const UNIT: Partial<Record<CrossField["key"], string>> = { price: "₽", total: "₽" };

/** Значение, введённое вручную: число для количества, цены и итога, непустой текст для остального. */
function validate(key: CrossField["key"], v: string): string | null {
  const t = v.trim();
  if (!t) return "Введите значение";
  if (NUMERIC.has(key) && !/^\d[\d\s ]*(?:[.,]\d+)?$/.test(t)) return "Введите число, например 95 или 22 800";
  if (key === "pack" && !/^\d[\d\s]*(?:[.,]\d+)?\s*×\s*\d[\d\s]*(?:[.,]\d+)?/.test(t)) return "Формат: 6 × 1000 шт";
  return null;
}

export function AiHint({ f, model = "ИИ", onConfirm }: { f: CrossField; model?: string; onConfirm: ConfirmField }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const [err, setErr] = useState<string | null>(null);

  if (f.status === "confirmed" && f.confirmed) {
    const how = f.confirmed.source === "edited" ? "введено вручную" : f.confirmed.source === "ai" ? `значение ${model} подтверждено` : "выбрано значение правил";
    return (
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
        <span className="inline-flex items-center gap-1 text-pay">
          <CircleCheck className="size-3.5" aria-hidden />
          {how}
        </span>
        <button type="button" onClick={() => onConfirm(f.key, "", null)} className="inline-flex items-center gap-0.5 text-muted-foreground underline decoration-line-strong underline-offset-2 hover:text-ink">
          <Undo2 className="size-3" aria-hidden />
          отменить
        </button>
      </div>
    );
  }

  const save = () => {
    const e = validate(f.key, val);
    if (e) return setErr(e);
    onConfirm(f.key, val.trim(), "edited");
    setEditing(false);
  };
  const startEdit = () => {
    setVal((f.status === "diff" ? f.rules : f.llm)?.replace(/ /g, " ") ?? "");
    setErr(null);
    setEditing(true);
  };

  return (
    <div className="mt-1 rounded-[6px] border border-dashed border-accent/60 bg-accent/[0.06] px-2 py-1.5 font-sans">
      <p className="flex items-center gap-1 text-[11.5px] text-accent">
        <Sparkles className="size-3.5 shrink-0" aria-hidden />
        {f.status === "diff" ? `Правила и ${model} прочитали по-разному` : `${model} прочитал из письма, правила не нашли`}
      </p>
      {f.status === "diff" ? (
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Button size="xs" variant="outline" onClick={() => onConfirm(f.key, f.rules ?? "", "rules")}>
            Правила: <span className="num font-semibold">{f.rules}</span>
          </Button>
          <Button size="xs" variant="outline" onClick={() => onConfirm(f.key, f.llm ?? "", "ai")}>
            {model}: <span className="num font-semibold">{f.llm}</span>
          </Button>
        </div>
      ) : (
        <p className="num mt-0.5 text-[14px] font-semibold text-ink">
          {f.llm}
          {UNIT[f.key] && !String(f.llm).includes("₽") ? ` ${UNIT[f.key]}` : ""}
        </p>
      )}
      {editing ? (
        <form
          className="mt-1.5 flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            autoFocus
            aria-label={`${f.label}: своё значение`}
            aria-invalid={!!err}
            value={val}
            onChange={(e) => {
              setVal(e.target.value);
              setErr(null);
            }}
            inputMode={NUMERIC.has(f.key) ? "decimal" : undefined}
            className={cn("num h-7 w-28 rounded-md border bg-surface px-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent/40", err ? "border-stop" : "border-line-strong")}
          />
          <Button size="xs" type="submit">Сохранить</Button>
          <Button size="xs" variant="ghost" type="button" onClick={() => setEditing(false)}>Отмена</Button>
          {err && <p className="w-full text-[12px] text-stop">{err}</p>}
        </form>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {f.status !== "diff" && (
            <Button size="xs" variant="outline" onClick={() => onConfirm(f.key, f.llm ?? "", "ai")}>
              <Check />
              Верно
            </Button>
          )}
          <Button size="xs" variant="outline" onClick={startEdit}>
            <Pencil />
            {f.status === "diff" ? "Другое значение" : "Исправить"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Поле разбора, к которому нужна подсказка или пометка о подтверждении. */
export function hintFor(fields: CrossField[] | undefined, keys: CrossField["key"][]): CrossField | undefined {
  return fields?.find((f) => keys.includes(f.key) && (f.status === "llm-only" || (f.status === "diff" && f.critical) || f.status === "confirmed"));
}
