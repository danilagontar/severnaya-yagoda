// Извлечение полей из свободного текста письма правилами (без сети).
// Тот же результат (Extracted) может вернуть LLM: см. src/llm.

import type { Extracted, FieldKey, LetterTopic, Packaging, Span } from "./types";

export const COMPANY_DOMAIN = "sev-yagoda.example";

const NUM_PLAIN = String.raw`\d[\d   ]*(?:[.,]\d+)?`;
const RUB = String.raw`(?:руб(?:\.|лей|ля)?|₽|р\.)`;

// «15.000,00»: тысячи через точку (ровно по три цифры), иначе обычная запись: «15 000,00», «4.40»
const NUM = String.raw`(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?(?![\d.])|${NUM_PLAIN})`;

export function parseNum(s: string): number {
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s.trim())) return Number(s.trim().replace(/\./g, "").replace(",", "."));
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

// Латинские буквы, похожие на русские, внутри русских слов («Cчёт» с латинской C).
// Замена буква на букву: длина текста не меняется, позиции для подсветки остаются верными.
const LAT2CYR: Record<string, string> = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у" };
export function fixHomoglyphs(t: string): string {
  return t.replace(/[ABCEHKMOPTXaceopxy]/g, (ch: string, i: number) => (/[а-яё]/i.test(t[i - 1] ?? "") || /[а-яё]/i.test(t[i + 1] ?? "") ? LAT2CYR[ch] : ch));
}

// «счёт 45», «счет № 0202», «Сч. 45», «счет номер 202», «счёт-фактура 12».
// Не «по счёту 205» (ссылка), не «расчётный счёт 40702…» и не 20-значный номер банковского счёта.
const INV_RE = String.raw`(?<!по\s)(?<!расч[её]тн[а-яё]*\s+)(?<![а-яё\/])(сч[её]т(?:а|ов|-фактур[а-яё]*)?|сч\.)\s*(?:№|номер)?\s*(\d{1,10}(?:\/\d+)?)(?![\d\/])`;
const stripZeros = (n: string) => n.replace(/^0+(?=\d)/, "");

/** Все номера счетов в тексте: первый: основной, остальные: «ещё счета в этом письме». */
function invoiceNumbers(text: string): { no: string; m: RegExpExecArray }[] {
  const out: { no: string; m: RegExpExecArray }[] = [];
  const seen = new Set<string>();
  const add = (no: string, m: RegExpExecArray) => {
    if (seen.has(stripZeros(no))) return;
    seen.add(stripZeros(no));
    out.push({ no, m });
  };
  const re = new RegExp(INV_RE, "gi");
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    add(m[2], m);
    // «счета 125 и 126», «счета 125, 126 и 127»
    if (/^сч[её]т(?:а|ов)$/i.test(m[1])) {
      const tail = /^((?:\s*,\s*(?:№\s*)?\d{1,10})*\s+и\s+(?:№\s*)?\d{1,10})(?![\d\/])/.exec(text.slice(m.index + m[0].length));
      if (tail) for (const n of tail[1].match(/\d{1,10}/g) ?? []) add(n, m);
    }
  }
  return out;
}

function extractPart(raw: string, sender: string): Extracted {
  const text = fixHomoglyphs(raw);
  const spans: Partial<Record<FieldKey, Span>> = {};
  const s = parseSender(sender);
  // если отправителя не указали отдельно: ищем «Название» в самом тексте
  if (!s.name) {
    const q = text.match(/«([^»]+)»/);
    if (q) s.name = q[1];
  }

  // --- номер счёта и ссылка на счёт в письме
  let invoiceNo: string | null = null;
  const invs = invoiceNumbers(text);
  if (invs[0]) {
    invoiceNo = invs[0].no;
    spans.invoiceNo = span(invs[0].m, 2);
  }
  const otherInvoices = invs.slice(1).map((x) => x.no);
  let invoiceRef: string | null = null;
  const ref = /по\s+сч[её]ту\s*(?:№\s*)?(\d+(?:\/\d+)?)/i.exec(text);
  if (ref) {
    invoiceRef = ref[1];
    spans.invoiceRef = span(ref, 1);
  }

  // --- заказ
  let orderNo: string | null = null;
  // «ЗП-08», «ЗП08», опечатки «3П-06» (цифра 3) и «ЗП-О8» (буква О вместо нуля)
  const ord = /(?<![\dа-яё])[З3]П\s*-?\s*([\dОO]{1,3})(?![\dа-яё])/i.exec(text);
  if (ord && /\d/.test(ord[1])) {
    orderNo = "ЗП-" + ord[1].replace(/[ОO]/gi, "0").padStart(2, "0");
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
    // «Итого 120 руб.», «Итого к оплате: 120 руб.», «К оплате 130 руб.», «120 (сто двадцать) руб.»
    new RegExp(String.raw`(?:(?:итого|всего)(?:\s+к\s+оплате)?|к\s+оплате|сумма(?:\s+сч[её]та)?|на\s+сумму)\s*:?\s*(${NUM})\s*(?:\([^)\d]{1,80}\)\s*)?${RUB}`, "i").exec(text) ??
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
  // Только смена получателя или банка. Просто слово «реквизиты» («реквизиты указаны в счёте»,
  // «реквизиты прежние») сменой не является.
  const rq =
    /(?:нов|друг)[а-яё]*\s+(?:банковск[а-яё]*\s+|платёжн[а-яё]*\s+|платежн[а-яё]*\s+)?реквизит|реквизит[а-яё]*\s+(?:изменил|сменил|поменял|обновил)[а-яё]*|(?:смен[аеуы]|изменени[еяю])\s+(?:банковск[а-яё]*\s+)?реквизит|(?:нов|друг)[а-яё]*\s+расч[её]тн[а-яё]*\s+сч[её]т|р\/с\s*\d|сменил[а-яё]*\s+банк|нов[а-яё]*\s+банк|от\s+другой\s+(?:фирмы|организации|компании)/i.exec(
      text,
    );
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
    asksPaymentDate: /дат[а-яё]*\s+оплат|когда\s+(?:ждать\s+|ожидать\s+|будет\s+|планируете\s+)?оплат/i.test(text),
    otherInvoices,
    spans,
    missing,
  };
}

// ---------- цитаты и пересылка ----------

const FWD_RE = /^[ \t]*-{2,}\s*(?:Пересланное сообщение|Forwarded message)\s*-*[ \t]*$/im;
const REPLY_RES = [
  /^[ \t]*-{2,}\s*(?:Original Message|Исходное сообщение)\s*-*[ \t]*$/im,
  /^[^\n]{0,160}(?:пишет|написал|написала|wrote)\s*:[ \t]*$/im,
  /^[ \t]*>/m,
];

function shiftSpans(ex: Extracted, by: number): Extracted {
  const spans: Extracted["spans"] = {};
  for (const [k, s] of Object.entries(ex.spans) as [FieldKey, Span][]) spans[k] = { start: s.start + by, end: s.end + by };
  return { ...ex, spans };
}

const hasInvoice = (ex: Extracted) => ex.invoiceNo !== null && (ex.total !== null || (ex.qty !== null && ex.price !== null));

/**
 * Разбор письма с учётом цитат и пересылки:
 * - ответ над цитатой: читаем то, что написано сверху; цитата не включает «стоп» и не меняет счёт;
 * - пересланное письмо (закупщик переслал счёт поставщика): разбираем пересланную часть от имени её отправителя;
 * - счёт есть только в цитате ответа: это повторная отправка того счёта.
 */
export function extractByRules(text: string, sender: string): Extracted {
  const fwd = FWD_RE.exec(text);
  const reply = REPLY_RES.map((re) => re.exec(text)).filter((m): m is RegExpExecArray => !!m && m.index > 0);
  const replyAt = reply.length ? Math.min(...reply.map((m) => m.index)) : -1;
  const cut = Math.min(...[fwd?.index ?? Infinity, replyAt >= 0 ? replyAt : Infinity]);
  if (!Number.isFinite(cut) || cut <= 0) return extractPart(text, sender);

  const own = extractPart(text.slice(0, cut), sender);
  if (hasInvoice(own)) return own;

  // пересылка: «---------- Пересланное сообщение ----------», затем «От: …»
  if (fwd && fwd.index === cut) {
    const start = fwd.index + fwd[0].length;
    const body = text.slice(start);
    const from = /^[ \t]*(?:От|From)\s*:\s*(.+)$/im.exec(body)?.[1]?.trim();
    const inner = shiftSpans(extractPart(body, from ?? sender), start);
    return { ...inner, forwardedBy: own.senderName ?? sender };
  }

  // ответ с цитатой: счёт только в цитате → повторная отправка; сигналы («стоп», обещания): только из своего текста
  const quoted = shiftSpans(extractPart(text.slice(cut), sender), cut);
  if (hasInvoice(quoted) && own.topic !== "buyer-note") {
    const spans = { ...quoted.spans };
    for (const k of ["requisites", "approvalClaim", "promise", "resend"] as FieldKey[]) delete spans[k];
    for (const k of ["requisites", "approvalClaim", "promise"] as FieldKey[]) if (own.spans[k]) spans[k] = own.spans[k];
    return {
      ...quoted,
      kind: "copy",
      topic: null,
      fromQuote: true,
      resend: true,
      requisitesChange: own.requisitesChange,
      approvalClaim: own.approvalClaim,
      approvalClaimDate: own.approvalClaimDate,
      promise: own.promise,
      asksPaymentDate: own.asksPaymentDate,
      spans,
    };
  }
  return { ...own, invoiceRef: own.invoiceRef ?? quoted.invoiceNo ?? quoted.invoiceRef, orderNo: own.orderNo ?? quoted.orderNo };
}
