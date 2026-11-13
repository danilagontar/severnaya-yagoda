import { useState } from "react";
import { ScanSearch, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEMO_LETTERS } from "@/data/demo-letters";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { LlmMode } from "@/llm/provider";

export function NewLetter({ onSubmit, onClose, llm, nextId }: { onSubmit: (sender: string, text: string) => Promise<void>; onClose: () => void; llm: LlmMode; nextId: string }) {
  const [sender, setSender] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!text.trim()) {
      setErr("Вставьте текст письма.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await onSubmit(sender.trim(), text.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="new-h" className="mx-auto flex max-w-[860px] flex-col gap-4 px-6 pt-6 pb-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 id="new-h" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">
            Новое письмо
          </h1>
          <p className="mt-1 max-w-[70ch] text-[13.5px] text-muted-foreground">
            Вставьте письмо из ящика бухгалтерии. Оно получит номер {nextId}, встанет в очередь, и вся очередь пересчитается: письмо о реквизитах или копия счёта меняют вердикт уже
            разобранных документов. Поля из текста извлекают {llm === "gigachat" ? "правила и ИИ независимо друг от друга" : "правила (ИИ не подключён)"}, суммы считает только код.
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Закрыть">
          <X />
        </Button>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-ink">Отправитель</span>
        <input
          value={sender}
          onChange={(e) => setSender(e.target.value)}
          placeholder="«Название поставщика», адрес@почты"
          className="h-9 rounded-md border border-input bg-surface px-3 text-[14px] text-ink placeholder:text-muted-foreground"
          autoComplete="off"
        />
        <span className="text-[12px] text-muted-foreground">Название в кавычках «» и адрес почты. Если пусто, ищем название в тексте письма.</span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-ink">Текст письма</span>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
          }}
          rows={7}
          placeholder="Вставьте текст письма…"
          className="bg-surface text-[14px] leading-relaxed"
        />
        <span className="text-[12px] text-muted-foreground">Например: «Счёт 130 по ЗП-07: термоэтикетка 100×150, 2 рулона по 1000 шт., цена рулона 1500 руб. Итого 3 000 руб.»</span>
      </label>
      {err && <p className="text-[13px] text-stop">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={submit} disabled={busy}>
          <ScanSearch />
          {busy ? "Проверяю…" : "Проверить письмо"}
        </Button>
        <span className="text-[12px] text-muted-foreground">Ctrl+Enter</span>
      </div>

      <section aria-labelledby="demo-h" className="mt-4 border-t border-line pt-4">
        <h2 id="demo-h" className="text-[15px] font-semibold text-ink">
          Демо-письма
        </h2>
        <p className="mt-0.5 mb-3 text-[12.5px] text-muted-foreground">Придуманы командой для показа, опираются на заказы из данных кейса. Нажмите, чтобы подставить письмо в форму.</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {DEMO_LETTERS.map((d) => (
            <li key={d.id}>
              <button
                onClick={() => {
                  setSender(d.sender);
                  setText(d.text);
                  setErr(null);
                }}
                className={cn(
                  "flex h-full w-full flex-col gap-0.5 rounded-[8px] border bg-surface px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-surface-2/60",
                  text === d.text ? "border-ink" : "border-line",
                )}
              >
                <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-ink">
                  {d.title}
                  {d.ai && (
                    <span className={cn("inline-flex items-center gap-0.5 rounded-[4px] px-1 text-[11px] font-semibold", llm === "gigachat" ? "bg-accent/10 text-accent" : "bg-surface-2 text-muted-foreground")}>
                      <Sparkles className="size-3" aria-hidden />
                      ИИ
                    </span>
                  )}
                </span>
                <span className="text-[12.5px] leading-snug text-muted-foreground">{d.shows}</span>
              </button>
            </li>
          ))}
        </ul>
        {llm !== "gigachat" && <p className="mt-2 text-[12px] text-muted-foreground">Письма с пометкой «ИИ» без подключённого ИИ разберутся только правилами.</p>}
      </section>
    </section>
  );
}
