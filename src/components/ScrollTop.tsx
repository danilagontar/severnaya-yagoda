// Телефон: кнопка «Наверх» в правом нижнем углу. Появляется, когда страницу прокрутили дальше первого экрана.
// Кнопка 40 px, область нажатия на 4 px шире с каждой стороны (after), чтобы попадать пальцем.
// На компьютере не нужна: очередь и карточка прокручиваются отдельно, шапка всегда видна.
import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

export function ScrollTop() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > window.innerHeight * 0.8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" })}
      aria-label="Наверх"
      tabIndex={shown ? 0 : -1}
      aria-hidden={!shown}
      className={cn(
        "fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 grid size-10 place-items-center after:absolute after:-inset-1 rounded-full border border-line-strong bg-surface text-ink shadow-[0_6px_18px_rgba(16,18,24,0.25)] transition-[opacity,transform] duration-200 active:scale-95 md:hidden",
        shown ? "opacity-100" : "pointer-events-none translate-y-2 opacity-0",
      )}
    >
      <ArrowUp className="size-[18px]" aria-hidden />
    </button>
  );
}
