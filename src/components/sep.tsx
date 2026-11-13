// Разделитель полей в строке: тонкая серая вертикальная черта (вместо «·»).
export function Sep() {
  return (
    <span aria-hidden className="mx-1.5 select-none font-normal text-muted-foreground/50">
      |
    </span>
  );
}
