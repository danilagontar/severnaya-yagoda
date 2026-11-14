import { useEffect, useRef, useState } from "react";
import { ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { LlmMode } from "@/llm/provider";

/**
 * Своё письмо: первый блок вкладки «Сценарии». В продукте письма приходят из общего ящика сами,
 * здесь вставка письма имитирует почту. По кнопке «Новое письмо» в шапке (focus)
 * форма прокручивается в видимую область и курсор ставится в поле текста; при обычном входе во вкладку нет.
 */
export function NewLetter({
  onSubmit,
  llm,
  nextId,
  focus,
  onFocused,
}: {
  onSubmit: (sender: string, text: string) => Promise<void>;
  llm: LlmMode;
  nextId: string;
  focus: boolean; // перейти к форме и поставить курсор (только по кнопке «Новое письмо», не при каждом входе во вкладку)
  onFocused: () => void;
}) {
  const [sender, setSender] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!focus) return;
    boxRef.current?.scrollIntoView({ block: "start" });
    textRef.current?.focus({ preventScroll: true });
    onFocused();
  }, [focus, onFocused]);

  const submit = async () => {
    if (!text.trim()) {
      setErr("Вставьте текст письма.");
      textRef.current?.focus();
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await onSubmit(sender.trim(), text.trim());
      setSender("");
      setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section ref={boxRef} aria-labelledby="new-h" className="scroll-mt-4 flex flex-col gap-4 rounded-[8px] border border-line bg-surface p-4 sm:p-5">
      <div>
        <h2 id="new-h" className="text-[17px] font-semibold text-ink">
          Своё письмо
        </h2>
        <p className="mt-1 max-w-[70ch] text-[13px] text-muted-foreground">
          Вставьте письмо, как будто оно пришло в ящик бухгалтерии. Оно получит номер {nextId}, встанет в очередь, и вся очередь пересчитается: письмо о реквизитах или копия счёта
          меняют вердикт уже разобранных документов. Поля из текста извлекают {llm === "gigachat" ? "правила и ИИ независимо друг от друга" : "правила (ИИ не подключён)"}, суммы считает
          только код.
        </p>
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
          ref={textRef}
          value={text}
          onChange={(e) => (setText(e.target.value), setErr(null))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
          }}
          rows={6}
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
    </section>
  );
}
