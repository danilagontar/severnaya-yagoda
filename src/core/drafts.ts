// Черновики писем по результату сверки. Шаблоны; LLM (если подключена) может переписать текст,
// но числа берутся только отсюда и проверяются после переписывания.

import { rub } from "./reconcile";
import type { Addressee, Result } from "./types";

export interface Draft {
  to: Addressee;
  subject: string;
  body: string;
}

const ROLE_TITLE: Record<Addressee["role"], string> = {
  buyer: "закупщику",
  supplier: "поставщику",
  warehouse: "складу",
  treasurer: "казначею",
  cfo: "финансовому директору",
  procurement: "в отдел закупок",
};
export const roleTitle = (a: Addressee) => ROLE_TITLE[a.role];

function greet(a: Addressee): string {
  if (a.role === "supplier") return "Добрый день!";
  const first = a.name.split(" ")[0];
  return /^[А-ЯЁ][а-яё]+$/.test(first) && a.role === "buyer" ? `${first}, добрый день!` : "Добрый день!";
}

function invoiceRef(r: Result, dative = false): string {
  const doc = r.ex.invoiceNo ? `${dative ? "счёту" : "счёт"} ${r.ex.invoiceNo}` : dative ? "письму" : "письмо";
  const parts = [doc, r.supplier ? `«${r.supplier}»` : null, r.orderId ? `по ${r.orderId}` : null];
  return parts.filter(Boolean).join(" ");
}

export function buildDraft(r: Result, to: Addressee, all: Result[]): Draft {
  const ref = invoiceRef(r);
  const issues = r.findings.filter((f) => f.level !== "info" && f.level !== "ok");
  const lines: string[] = [greet(to), ""];
  let subject = `${r.id}: ${ref}`;

  if (to.role === "supplier") {
    subject = `Счёт ${r.ex.invoiceNo ?? ""}: просим исправить`.trim();
    lines.push(`Получили ${ref} на ${rub(r.invoiced)}. Принять его к оплате не можем:`);
    issues.forEach((f, i) => lines.push(`${i + 1}. ${f.text}`));
    if (r.due !== null && r.invoiced !== null && r.due !== r.invoiced) lines.push("", `По нашим данным сумма счёта должна быть ${rub(r.due)}.`);
    lines.push("", "Пришлите, пожалуйста, исправленный счёт с тем же номером.");
  } else if (to.role === "treasurer") {
    subject = `${r.id}: поставщик спрашивает дату оплаты`;
    const orig = r.duplicateOf ? all.find((x) => x.id === r.duplicateOf) : undefined;
    lines.push(`${r.supplier ? `«${r.supplier}»` : "Поставщик"} повторно прислал ${ref} и спрашивает дату оплаты.`);
    lines.push(`Это копия ${orig ? `${orig.id} (${orig.headline.toLowerCase()})` : "уже полученного счёта"}, отдельно не оплачиваем.`);
    lines.push("Дату сообщим после решения по исходному счёту.");
  } else if (to.role === "warehouse") {
    subject = `${r.orderId}: принято больше, чем заказано`;
    const q = r.findings.find((f) => /сверх|принял/.test(f.text));
    lines.push(`По ${r.orderId} проведена приёмка сверх заказа: ${q?.text ?? ""}`);
    lines.push("Подскажите, пожалуйста, на каком основании принят излишек и есть ли он на складе.");
  } else if (to.role === "cfo") {
    subject = `${r.id}: смена получателя платежа, нужно решение`;
    lines.push(`По ${invoiceRef(r, true)} есть признаки смены получателя платежа:`);
    issues.filter((f) => f.rule === "П-2").forEach((f, i) => lines.push(`${i + 1}. ${f.text}`));
    lines.push("", `Платёж${r.invoiced ? ` на ${rub(r.invoiced)}` : ""} в реестр не включаю до подтверждения закупщиком и подписанного допсоглашения в Directum RX (П-2).`);
  } else {
    subject = `${r.id}: вопрос по ${r.ex.invoiceNo ? `счёту ${r.ex.invoiceNo}` : "письму"}${r.supplier ? ` «${r.supplier}»` : ""}`;
    lines.push(`Разбираю ${ref}${r.invoiced ? ` на ${rub(r.invoiced)}` : ""}. Без вашего ответа платёж не готовлю:`);
    issues.forEach((f, i) => lines.push(`${i + 1}. ${f.text}`));
    if (r.due !== null && r.invoiced !== null && r.due !== r.invoiced) lines.push("", `По данным ERP и приёмки к оплате сейчас ${rub(r.due)} вместо ${rub(r.invoiced)}.`);
    const ask: string[] = [];
    if (issues.some((f) => f.rule === "П-6" && /цен/i.test(f.text))) ask.push("подтвердите цену: нужно подписанное согласование в Directum RX или счёт по цене заказа");
    if (issues.some((f) => f.rule === "П-5")) ask.push("пришлите условия договора о предоплате");
    if (issues.some((f) => f.rule === "П-2")) ask.push("подтвердите реквизиты поставщика");
    if (issues.some((f) => f.rule === "П-3")) ask.push("поясните, какие из счетов по заказу к оплате");
    if (issues.some((f) => f.rule === "П-6" && /сверх/.test(f.text))) ask.push("решите, согласуем излишек или возвращаем");
    if (ask.length) lines.push("", "Прошу: " + ask.join("; ") + ".");
  }
  lines.push("", "Спасибо!", "Бухгалтерия «Северной ягоды»");
  return { to, subject, body: lines.join("\n") };
}

/** Все числа (с разрядами) из текста — для проверки, что LLM не изменила суммы. */
export function numbersIn(s: string): string[] {
  return (s.match(/\d[\d   ]*(?:[.,]\d+)?/g) ?? []).map((x) => x.replace(/[   ]/g, "")).filter((x) => x.length > 1);
}
