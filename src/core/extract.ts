// Извлечение полей из свободного текста письма правилами (без сети).
// Тот же результат (Extracted) может вернуть LLM — см. src/llm.

import type { Extracted, FieldKey, LetterTopic, Packaging, Span } from "./types";

export const COMPANY_DOMAIN = "sev-yagoda.example";

const NUM = String.raw`\d[\d   ]*(?:[.,]\d+)?`;
const RUB = String.raw`(?:руб(?:\.|лей|ля)?|₽|р\.)`;

export function parseNum(s: string): number {
  return Number(s.replace(/[   ]/g, "").replace(",", "."));
}

export function normUnit(u: string): string | null {
  const s = u.toLowerCase().replace(/\.$/, "");
  if (/^шт/.test(s)) return "шт";
  if (/^кг|^килограмм/.test(s)) return "кг";
  if (/^рул/.test(s)) return "рул";
  if (/^меш/.test(s)) return "мешок";
  if (/^пач/.test(s)) return "пачка";
  if (/^упак/.test(s)) return "упаковка";
  return null;
}

const UNIT_RE = String.raw`(шт(?:ук|\.)?|кг|килограмм[а-яё]*|рул(?:онов|она|он|\.)?|мешк[а-яё]*|мешок|пач(?:ек|ки|ка)|упаков[а-яё]*)`;
const PACK_RE = String.raw`(мешк[а-яё]*|мешок|рулон[а-яё]*|рул\.?|пач(?:ек|ки|ка)|упаков[а-яё]*)`;

function span(m: RegExpExecArray, group = 0): Span {
  const start = m.index + (group ? m[0].indexOf(m[group]) : 0);
  return { start, end: start + m[group].length };
}

export function parseSender(sender: string): { name: string | null; email: string | null; domain: string | null } {
  const email = sender.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] ?? null;
  const quoted = sender.match(/«([^»]+)»/)?.[1] ?? sender.match(/"([^"]+)"/)?.[1] ?? null;
  const name = quoted ?? (sender.split(",")[0].trim() || null);
  return { name: name && !name.includes("@") ? name : null, email, domain: email ? email.split("@")[1].toLowerCase() : null };
}

export function extractByRules(text: string, sender: string): Extracted {
  const spans: Partial<Record<FieldKey, Span>> = {};
  const s = parseSender(sender);
  // если отправителя не указали отдельно — ищем «Название» в самом тексте
  if (!s.name) {
    const q = text.match(/«([^»]+)»/);
    if (q) s.name = q[1];
  }

  // --- номер счёта и ссылка на счёт в письме
  let invoiceNo: string | null = null;
  // «счёт 45», «счет № 0202», «копию счета 118», «счёт-фактура 12»; но не «по счёту 205» (это ссылка, см. ниже)
  const inv = /(?<!по\s)сч[её]т(?:а|-фактур[а-яё]*)?\s*(?:№\s*)?(\d+(?:\/\d+)?)(?!\d)/i.exec(text);
  if (inv) {
    invoiceNo = inv[1];
    spans.invoiceNo = span(inv, 1);
  }
  let invoiceRef: string | null = null;
  const ref = /по\s+сч[её]ту\s*(?:№\s*)?(\d+(?:\/\d+)?)/i.exec(text);
  if (ref) {
    invoiceRef = ref[1];
    spans.invoiceRef = span(ref, 1);
  }

  // --- заказ
  let orderNo: string | null = null;
  const ord = /ЗП\s*-?\s*(\d{1,3})/i.exec(text);
  if (ord) {
    orderNo = "ЗП-" + ord[1].padStart(2, "0");
    spans.orderNo = span(ord);
  }
  let orderDateRef: string | null = null;
  const od = /заказ[а-яё]*\s+от\s+(\d{1,2}\.\d{1,2})/i.exec(text);
  if (od) {
    orderDateRef = od[1].split(".").map((p) => p.padStart(2, "0")).join(".");
    spans.orderDateRef = span(od, 1);
  }

  // --- фасовка: «10 мешков по 20 кг», «10 рулонов по 1000 шт.»
  let pack: Packaging | null = null;
  let qtyStart = -1;
  const pk = new RegExp(String.raw`(${NUM})\s*${PACK_RE}\s+по\s+(${NUM})\s*(шт|кг)`, "i").exec(text);
  if (pk) {
    pack = { count: parseNum(pk[1]), packUnit: normUnit(pk[2]) ?? pk[2], perPack: parseNum(pk[3]), innerUnit: pk[4].toLowerCase() };
    spans.qty = span(pk);
    qtyStart = pk.index;
  }

  // --- цена
  let price: number | null = null;
  let pricePer: "unit" | "pack" | null = null;
  let priceIdx = -1;
  const pc = new RegExp(String.raw`цена\s*(мешка|рулона|пачки|упаковки|за\s+\S+)?\s*[:—-]?\s*(${NUM})\s*${RUB}`, "i").exec(text);
  const pp = new RegExp(String.raw`по\s+(${NUM})\s*${RUB}`, "i").exec(text);
  if (pc) {
    price = parseNum(pc[2]);
    pricePer = pc[1] && /мешка|рулона|пачки|упаковки/i.test(pc[1]) ? "pack" : "unit";
    spans.price = span(pc);
    priceIdx = pc.index;
  } else if (pp) {
    price = parseNum(pp[1]);
    pricePer = "unit";
    spans.price = span(pp);
    priceIdx = pp.index;
  }

  // --- количество (если не фасовка): ближайшее к цене упоминание «N ед.»
  let qty: number | null = pack ? pack.count : null;
  let unit: string | null = pack ? pack.packUnit : null;
  if (!pack) {
    const re = new RegExp(String.raw`(?<![\d×хx*])(${NUM})\s*${UNIT_RE}(?![а-яё])`, "gi");
    const all = [...text.matchAll(re)];
    let best: RegExpMatchArray | null = null;
    for (const m of all) {
      if (priceIdx >= 0 && (m.index ?? 0) > priceIdx) break;
      best = m;
    }
    if (!best && all.length) best = all[all.length - 1];
    if (best) {
      qty = parseNum(best[1]);
      unit = normUnit(best[2]);
      qtyStart = best.index ?? -1;
      spans.qty = { start: qtyStart, end: qtyStart + best[0].length };
    }
  }
  if (pack && pricePer === "unit" && price !== null && spans.price && /цена\s+(мешка|рулона|пачки)/i.test(text)) pricePer = "pack";

  // --- итог
  let total: number | null = null;
  const tt =
    new RegExp(String.raw`(?:итого|всего|сумма(?:\s+сч[её]та)?|на\s+сумму)\s*:?\s*(${NUM})\s*${RUB}`, "i").exec(text) ??
    new RegExp(String.raw`(?<![а-яё\w])на\s+(${NUM})\s*${RUB}`, "i").exec(text);
  if (tt) {
    total = parseNum(tt[1]);
    spans.total = span(tt);
  }

  // --- материал: текст между заголовком («…:» или «за») и количеством
  let material: string | null = null;
  // счёт-таблица: «Товар: …» / «Наименование: …» на отдельной строке
  const labeled = /(?:товар|наименование|материал|продукция)\s*:\s*([^\n]+)/i.exec(text);
  if (labeled) {
    material = labeled[1].trim();
    spans.material = span(labeled, 1);
  }
  if (!material && qtyStart > 0) {
    const head = text.slice(0, qtyStart);
    const colon = head.lastIndexOf(":");
    const za = /(?<![а-яё\w])за\s+/i.exec(head);
    // кандидаты: после двоеточия; после «за» (до «по заказу…»/двоеточия); после номера заказа/счёта
    const cands: [number, number][] = [];
    if (colon >= 0) cands.push([colon + 1, qtyStart]);
    if (za) {
      const zStart = za.index + za[0].length;
      const stop = head.slice(zStart).search(/\s+по\s+заказ|\s+по\s+ЗП|:/i);
      cands.push([zStart, stop >= 0 ? zStart + stop : qtyStart]);
    }
    cands.push([spans.orderNo?.end ?? spans.invoiceNo?.end ?? 0, qtyStart]);
    const [start, end] = cands.find(([a, b]) => /[а-яё]{3,}/i.test(text.slice(a, b))) ?? cands[0];
    const seg = text.slice(start, end);
    const parts = seg.split(",").map((p) => p.trim()).filter(Boolean);
    while (parts.length > 1 && !/\d/.test(parts[parts.length - 1])) parts.pop();
    const mat = parts
      .join(", ")
      .replace(/^[\s.,;:!—-]+|[\s,:—-]+$/g, "")
      // «Отгрузили пакеты … в количестве» → «пакеты …»
      .replace(/^(?:мы\s+)?(?:отгрузили|поставили|направляем|высылаем|отправили|привезли)\s+/i, "")
      .replace(/\s+(?:в\s+количестве|количеством|в\s+объ[её]ме)$/i, "")
      .trim();
    if (mat && mat.length < 120) {
      material = mat;
      const at = text.indexOf(mat, start);
      if (at >= 0) spans.material = { start: at, end: at + mat.length };
    }
  }

  const batch = text.match(/(перв|втор|трет)[а-яё]*\s+парти[а-яё]*/i)?.[0] ?? null;

  // --- признаки
  const rq = /реквизит|р\/с|расч[её]тн[а-яё]*\s+сч[её]т|сменил[а-яё]*\s+банк|от\s+другой\s+фирмы|новый\s+банк/i.exec(text);
  if (rq) spans.requisites = span(rq);
  const rs = /повторно|копи[яюи]\s+сч[её]т|дубликат/i.exec(text);
  if (rs) spans.resend = span(rs);
  const ac = /(?:по\s+)?допсоглашени[а-яё]*(?:\s+от\s+(\d{1,2}\.\d{1,2}))?|по\s+новому\s+прайсу|новая\s+цена|как\s+договаривались|согласно\s+договор[её]нност[а-яё]*/i.exec(text);
  if (ac) spans.approvalClaim = span(ac);
  const pr = /(?:привез[её]м|отгрузим|доставим|поставим|довез[её]м)[^.]*/i.exec(text);
  if (pr) spans.promise = span(pr);

  const isBuyerNote = s.domain === COMPANY_DOMAIN;
  const isCorrection = /исправленн/i.test(text);
  const hasMoney = total !== null || (qty !== null && price !== null);

  let kind: Extracted["kind"];
  if (invoiceNo && rs) kind = "copy";
  else if (invoiceNo && isCorrection && hasMoney) kind = "correction";
  else if (invoiceNo && hasMoney && !isBuyerNote) kind = "invoice";
  else kind = "letter";

  let topic: LetterTopic | null = null;
  if (kind === "letter") {
    if (isBuyerNote) topic = "buyer-note";
    else if (rq) topic = "requisites";
    else if (pr) topic = "delivery-promise";
    else topic = "other";
  }

  const missing: FieldKey[] = [];
  if (kind === "invoice" || kind === "correction") {
    if (!orderNo && !orderDateRef) missing.push("orderNo");
    if (qty === null) missing.push("qty");
    if (price === null) missing.push("price");
    if (total === null) missing.push("total");
    if (!material) missing.push("material");
  }

  return {
    source: "rules",
    senderName: s.name,
    senderEmail: s.email,
    senderDomain: s.domain,
    kind,
    topic,
    invoiceNo,
    invoiceRef,
    orderNo,
    orderDateRef,
    material,
    qty,
    unit,
    pack,
    price,
    pricePer,
    total,
    batch,
    requisitesChange: !!rq,
    resend: !!rs,
    approvalClaim: ac ? ac[0] : null,
    approvalClaimDate: ac?.[1] ? ac[1].split(".").map((p) => p.padStart(2, "0")).join(".") : null,
    promise: pr ? pr[0].trim() : null,
    asksPaymentDate: /дат[а-яё]*\s+оплат/i.test(text),
    spans,
    missing,
  };
}
