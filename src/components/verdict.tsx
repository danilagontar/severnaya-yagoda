import { CircleCheck, CircleHelp, Undo2, CopyX, Mail, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Verdict } from "@/core/types";

// «Стоп»: единственный вердикт с залитым знаком: красный только внутри восьмиугольника, без внешней заливки.
function StopIcon({ className }: { className?: string; strokeWidth?: number }) {
  return (
    // одна SVG в сетке 24×24, как у Lucide: восьмиугольник и крест в общей системе координат, без сдвига при округлении
    <svg viewBox="0 0 24 24" className={cn("shrink-0 text-stop", className)} aria-hidden fill="none" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="8.1,2 15.9,2 22,8.1 22,15.9 15.9,22 8.1,22 2,15.9 2,8.1" fill="currentColor" stroke="currentColor" strokeWidth={2} />
      <path d="M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8" stroke="#fff" strokeWidth={3.4} />
    </svg>
  );
}

type Meta = { label: string; long: string; icon: LucideIcon | typeof StopIcon; text: string; bg: string; ring: string };
export const VERDICT: Record<Verdict, Meta> = {
  pay: { label: "Оплатить", long: "К оплате", icon: CircleCheck, text: "text-pay", bg: "bg-pay/10", ring: "ring-pay/30" },
  ask: { label: "Вопрос", long: "Нужен ответ", icon: CircleHelp, text: "text-ask", bg: "bg-ask/10", ring: "ring-ask/30" },
  return: { label: "Вернуть", long: "Вернуть поставщику", icon: Undo2, text: "text-return", bg: "bg-return/10", ring: "ring-return/30" },
  duplicate: { label: "Дубль", long: "Дубль или заменён", icon: CopyX, text: "text-dup", bg: "bg-dup/10", ring: "ring-dup/30" },
  stop: { label: "Стоп", long: "Стоп: смена получателя платежа", icon: StopIcon, text: "text-ink font-semibold", bg: "bg-surface", ring: "ring-line-strong" },
  letter: { label: "Письмо", long: "Письмо, контекст", icon: Mail, text: "text-letter", bg: "bg-letter/10", ring: "ring-letter/25" },
};

/** Цвет вердикта для текста вне метки (у «стопа»: красный). */
export const verdictTextColor = (v: Verdict) => (v === "stop" ? "text-stop" : VERDICT[v].text);

export function VerdictIcon({ v, className }: { v: Verdict; className?: string }) {
  const m = VERDICT[v];
  const Icon = m.icon;
  return <Icon className={cn(v === "stop" ? "" : verdictTextColor(v), className)} strokeWidth={2.2} aria-hidden />;
}

export function VerdictTag({ v, size = "sm", className }: { v: Verdict; size?: "sm" | "lg"; className?: string }) {
  const m = VERDICT[v];
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-[5px] font-medium ring-1 ring-inset",
        m.text,
        m.bg,
        m.ring,
        size === "sm" ? "h-[22px] px-1.5 text-[12px] whitespace-nowrap" : "min-h-8 px-2.5 py-1 text-[15px] leading-tight",
        className,
      )}
    >
      <VerdictIcon v={v} className={size === "sm" ? "size-3.5" : "size-[18px]"} />
      {size === "sm" ? m.label : m.long}
    </span>
  );
}

export const fmtRub = (n: number | null | undefined) =>
  n === null || n === undefined ? "нет" : n.toLocaleString("ru-RU", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }) + " ₽";
