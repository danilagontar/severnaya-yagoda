// Извлечение полей из свободного текста письма правилами (без сети).
// Тот же результат (Extracted) может вернуть LLM: см. src/llm.

import type { Extracted, FieldKey, LetterTopic, Packaging, Span } from "./types";

export const COMPANY_DOMAIN = "sev-yagoda.example";

// разделители тысяч: пробелы (в т.ч. неразрывные) и апостроф «22'800» (бухгалтерские выгрузки)
const NUM_PLAIN = String.raw`\d(?:[\d \u00a0\u202f]|['’](?=\d{3}))*(?:[.,]\d+|-\d{2}(?=\s*(?:руб|р\.|₽)))?`; // «95-00 руб.»: копейки через дефис
const RUB = String.raw`(?:руб(?:\.|лей|ля)?|₽|р\.)`;

// «15.000,00»: тысячи через точку (ровно по три цифры), иначе обычная запись: «15 000,00», «4.40»
const NUM = String.raw`(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?(?![\d.])|${NUM_PLAIN})`;

export function parseNum(s: string): number {
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s.trim())) return Number(s.trim().replace(/\./g, "").replace(",", "."));
  return Number(s.replace(/[ \u00a0\u202f'’]/g, "").replace(/-(\d{2})$/, ".$1").replace(",", "."));
}

export function normUnit(u: string): string | null {
  const s = u.toLowerCase().replace(/\.$/, "");
  if (/^шт/.test(s)) return "шт";
  if (/^кг|^килограмм/.test(s)) return "кг";
  if (/^рул/.test(s)) return "рул";
  if (/^меш/.test(s)) return "мешок";
  if (/^пач/.test(s)) return "пачка";
  if (/^упак/.test(s)) return "упаковка";
  if (/^т(?:онн|$)/.test(s)) return "т";
  // «бобина» у риббона и ленты: тот же рулон; «ед.», «единиц»: штуки
  if (/^бобин/.test(s)) return "рул";
  if (/^ед(?:$|иниц)/.test(s)) return "шт";
  if (/^короб/.test(s)) return "коробка";
  // английские счета: «240 rolls», «500 pcs»
  if (/^rolls?$/.test(s)) return "рул";
  if (/^(?:pcs|pieces?|units?)$/.test(s)) return "шт";
  if (/^kgs?$/.test(s)) return "кг";
  return null;
}

const UNIT_RE = String.raw`(шт(?:ук|\.)?|кг|килограмм[а-яё]*|рул(?:онов|она|он|\.)?|бобин[а-яё]*|ед\.|единиц[а-яё]*|мешк[а-яё]*|мешок|пач(?:ек|ки|ка)|упаков[а-яё]*|тонн[а-яё]*|т\.?|rolls?|pcs|pieces?|kgs?)`;
// пропись в скобках между числом и единицей: «240 (двести сорок) рулонов»
const WORDS_RE = String.raw`(?:\([^)\d]{1,60}\)\s*)?`;
// «6 тыс. шт.», «22,8 тыс. руб.»: множитель между числом и единицей
const THOUSAND_RE = String.raw`(тыс\.?\s*|тысяч[а-яё]*\s+)?`;
const PACK_RE = String.raw`(мешк[а-яё]*|мешок|рулон[а-яё]*|рул\.?|пач(?:ек|ки|ка)|упаков[а-яё]*|коробк[а-яё]*|коробок)`;

function span(m: RegExpExecArray, group = 0): Span {
  const start = m.index + (group ? m[0].indexOf(m[group]) : 0);
  return { start, end: start + m[group].length };
}

export function parseSender(sender: string): { name: string | null; email: string | null; domain: string | null } {
  const email = sender.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] ?? null;
  const quoted = sender.match(/«([^»]+)»/)?.[1] ?? sender.match(/"([^"]+)"/)?.[1] ?? null;
  // «Лентапром (бухгалтерия) <schet@…>»: убираем адрес в угловых скобках и пояснение в круглых
  const bare = sender.replace(/<[^>]*>/g, "").replace(/\([^)]*\)/g, "").split(",")[0].trim();
  const raw = quoted ?? (bare || null);
  // «Лeнтапром» с латинской e: сравниваем с поставщиками по русскому написанию
  const name = raw ? fixHomoglyphs(raw).trim() : null;
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
// «Счёт на оплату № 52», «счёт на предоплату 89», «счёт-оферта 33», «invoice 52».
const INV_RE = String.raw`(?<!по\s)(?<!расч[её]тн[а-яё]*\s+)(?<![а-яё\/])(сч[её]т(?:а|ов|-фактур[а-яё]*|-оферт[а-яё]*)?|сч\.|invoice)(?:\s+на\s+(?:пред)?оплату)?\s*:?\s*(?:№|N[o°]?\.?|номер|#)?\s*(\d{1,10}(?:\/\d+)?)(?![\d\/])`;
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

interface TableRow {
  material: string | null;
  qty: number | null;
  unit: string | null;
  price: number | null;
  spans: Partial<Record<"material" | "qty" | "price", Span>>;
}

/** Первая строка товара под заголовком таблицы (колонки через табуляцию или «|»). */
function readTable(text: string): TableRow | null {
  const lines = text.split("\n");
  let pos = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const sep = line.includes("\t") ? "\t" : line.includes("|") ? "|" : null;
    const head = sep ? line.split(sep).map((c) => c.trim().toLowerCase()) : [];
    const col = (re: RegExp) => head.findIndex((c) => re.test(c));
    const iQty = col(/^кол(?:-во|ичество)/);
    const iPrice = col(/^цена/);
    if (!sep || iQty < 0 || iPrice < 0) {
      pos += line.length + 1;
      continue;
    }
    const iName = col(/^(?:наименование|товар|материал)/);
    const iUnit = col(/^ед/);
    const rowAt = pos + line.length + 1;
    const cells = lines[i + 1].split(sep);
    // смещение каждой ячейки в тексте: для подсветки
    const offs: number[] = [];
    let o = rowAt;
    for (const c of cells) {
      offs.push(o);
      o += c.length + 1;
    }
    const cell = (k: number) => (k >= 0 && cells[k] !== undefined ? cells[k].trim() : "");
    const cspan = (k: number): Span | undefined => {
      if (k < 0 || cells[k] === undefined) return undefined;
      const lead = cells[k].length - cells[k].trimStart().length;
      return { start: offs[k] + lead, end: offs[k] + lead + cells[k].trim().length };
    };
    const n = (s: string) => (new RegExp(String.raw`^${NUM}$`).test(s) ? parseNum(s) : null);
    const qty = n(cell(iQty));
    const unit = iUnit >= 0 ? normUnit(cell(iUnit)) : null;
    const price = n(cell(iPrice));
    if (qty === null || price === null || !unit) return null;
    return {
      material: cell(iName) || null,
      qty,
      unit,
      price,
      spans: { material: cspan(iName), qty: cspan(iQty), price: cspan(iPrice) },
    };
  }
  return null;
}

function extractPart(raw: string, sender: string): Extracted {
  // «&nbsp;» из HTML-письма: шесть пробелов той же длины, чтобы позиции подсветки не сдвинулись
  const text = fixHomoglyphs(raw).replace(/&nbsp;/gi, "      ");
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
  const ord = /(?<![\dа-яёa-z])(?:[З3]П|ZP)\s*-?\s*([\dОO]{1,3})(?![\dа-яё])/i.exec(text);
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
  // «цена за 1000 шт. 2 000 руб.»: цена за несколько единиц, в цену за единицу
  const pn = new RegExp(String.raw`цена\s+за\s+(${NUM})\s*(шт|кг|рул)[а-яё.]*\s*[:—-]?\s*(${NUM})\s*${RUB}`, "i").exec(text);
  const pc = new RegExp(String.raw`цена\s*(мешка|рулона|пачки|упаковки|коробки|за\s+\S+)?\s*[:—-]?\s*(${NUM})\s*${RUB}`, "i").exec(text);
  const pp = new RegExp(String.raw`(?:по|at)\s+(${NUM})\s*(?:${RUB}|RUB|rub)`, "i").exec(text);
  // «240 рул. × 95 р.», «180 руб./кг»: цена за единицу без слов «цена» и «по»
  const px = new RegExp(String.raw`[×*]\s*(${NUM})\s*${RUB}|(?<![\d,.])(${NUM})\s*${RUB}\s*\/\s*(?:кг|шт|рул)`, "i").exec(text);
  if (pn && parseNum(pn[1]) > 1) {
    price = Math.round((parseNum(pn[3]) / parseNum(pn[1])) * 10000) / 10000;
    pricePer = "unit";
    spans.price = span(pn);
    priceIdx = pn.index;
  } else if (pc) {
    price = parseNum(pc[2]);
    pricePer = pc[1] && /мешка|рулона|пачки|упаковки|коробки/i.test(pc[1]) ? "pack" : "unit";
    spans.price = span(pc);
    priceIdx = pc.index;
  } else if (pp) {
    price = parseNum(pp[1]);
    pricePer = "unit";
    spans.price = span(pp);
    priceIdx = pp.index;
  } else if (px) {
    price = parseNum(px[1] ?? px[2]);
    pricePer = "unit";
    spans.price = span(px);
    priceIdx = px.index;
  }

  // --- количество (если не фасовка): ближайшее к цене упоминание «N ед.»
  let qty: number | null = pack ? pack.count : null;
  let unit: string | null = pack ? pack.packUnit : null;
  if (!pack) {
    // «цена за 1000 шт.» это основание цены, а не количество («за 240 рул. ленты» количество)
    const re = new RegExp(String.raw`(?<![\d×хx*])(?<!цен[аы]\s+за\s)(${NUM})\s*${WORDS_RE}${THOUSAND_RE}${UNIT_RE}(?![а-яёa-z])`, "gi");
    const all = [...text.matchAll(re)];
    let best: RegExpMatchArray | null = null;
    for (const m of all) {
      if (priceIdx >= 0 && (m.index ?? 0) > priceIdx) break;
      best = m;
    }
    if (!best && all.length) best = all[all.length - 1];
    if (best) {
      qty = parseNum(best[1]) * (best[2] ? 1000 : 1);
      unit = normUnit(best[3]);
      qtyStart = best.index ?? -1;
      spans.qty = { start: qtyStart, end: qtyStart + best[0].length };
    }
  }
  if (pack && pricePer === "unit" && price !== null && spans.price && /цена\s+(мешка|рулона|пачки|коробки)/i.test(text)) pricePer = "pack";

  // --- счёт таблицей: строка заголовка «Наименование | Кол-во | Ед. | Цена | Сумма» через табуляцию или «|»
  const table = readTable(text);
  if (table) {
    if (qty === null && table.qty !== null) {
      qty = table.qty;
      unit = table.unit;
      spans.qty = table.spans.qty;
    }
    if (price === null && table.price !== null) {
      price = table.price;
      pricePer = "unit";
      spans.price = table.spans.price;
    }
  }

  // --- итог
  let total: number | null = null;
  const tt =
    // «Итого 120 руб.», «Итого к оплате: 120 руб.», «К оплате 130 руб.», «120 (сто двадцать) руб.»
    // «Итого с учётом скидки 5%: 21 660 руб.», «Итого 22,8 тыс. руб.»
    new RegExp(String.raw`(?:(?:итого|всего)(?:\s+к\s+оплате)?|к\s+оплате|сумма(?:\s+сч[её]та)?|на\s+сумму)(?:\s+(?:без|с|включая)\s+НДС)?(?:\s+с\s+уч[её]том\s+скидк[а-яё]*(?:\s+\d+(?:[.,]\d+)?\s*%)?)?\s*:?\s*(${NUM})\s*${THOUSAND_RE}(?:\([^)\d]{1,80}\)\s*)?${RUB}`, "i").exec(text) ??
    new RegExp(String.raw`(?<![а-яё\w])на\s+(${NUM})\s*${THOUSAND_RE}${RUB}`, "i").exec(text) ??
    // «Итого: ₽22 800» (знак рубля перед числом), «= 22 800 р.» (запись формулой), «Total 22 800 RUB»
    new RegExp(String.raw`(?:итого|всего|к\s+оплате)\s*:?\s*₽\s*(${NUM})()`, "i").exec(text) ??
    new RegExp(String.raw`=\s*(${NUM})\s*${THOUSAND_RE}${RUB}`, "i").exec(text) ??
    new RegExp(String.raw`total\s*:?\s*(${NUM})\s*()(?:RUB|rub|₽|руб)`, "i").exec(text);
  if (tt) {
    total = Math.round(parseNum(tt[1]) * (tt[2] ? 1000 : 1) * 100) / 100;
    spans.total = span(tt);
  }

  // --- материал: текст между заголовком («…:» или «за») и количеством
  let material: string | null = null;
  // счёт-таблица: «Товар: …» / «Наименование: …» на отдельной строке
  const labeled = /(?:товар|наименование|материал|продукция)\s*:\s*([^\n]+)/i.exec(text);
  if (labeled) {
    material = labeled[1].trim();
    spans.material = span(labeled, 1);
  } else if (table?.material) {
    material = table.material;
    spans.material = table.spans.material;
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
  // «Итого 22 800 руб. за 240 рул. ленты клейкой 48 мм × 66 м по 95 руб.»: материал после количества
  if (!material && spans.qty) {
    const after = /^\s*([^,.;:\n]*?[а-яё]{3,}[^,;:\n]*?)(?=\s+по\s|\s*[,;:\n]|\.\s|\.?$)/i.exec(text.slice(spans.qty.end));
    if (after && after[1].trim().length < 120) {
      material = after[1].trim();
      const at = text.indexOf(material, spans.qty.end);
      if (at >= 0) spans.material = { start: at, end: at + material.length };
    }
  }

  // валюта: сверка ведётся в рублях, счёт в другой валюте сверять нельзя
  const cur = /(?<![a-zа-яё])(USD|EUR|CNY|долл[а-яё]*|евро|юан[а-яё]*)(?![a-zа-яё])|[$€¥]/i.exec(text);
  const curRaw = cur ? (cur[1] ?? cur[0]).toLowerCase() : null;
  const currency = !curRaw ? null : /^(usd|долл|\$)/.test(curRaw) ? "USD" : /^(eur|евро|€)/.test(curRaw) ? "EUR" : "CNY";
  // «скидка 5%»: цена в счёте до скидки, итог после
  const disc = /скидк[а-яё]*\s*(?:в\s+размере\s+)?(\d{1,2}(?:[.,]\d+)?)\s*%/i.exec(text);
  const discountPct = disc ? Number(disc[1].replace(",", ".")) : null;

  const batch = text.match(/(перв|втор|трет)[а-яё]*\s+парти[а-яё]*/i)?.[0] ?? null;

  // --- признаки
  // Только смена получателя или банка. Просто слово «реквизиты» («реквизиты указаны в счёте»,
  // «реквизиты прежние») и номер р/с в подвале счёта сменой не являются.
  const rqFound =
    /(?:нов|друг)[а-яё]*\s+(?:банковск[а-яё]*\s+|платёжн[а-яё]*\s+|платежн[а-яё]*\s+)?реквизит|реквизит[а-яё]*\s+(?:изменил|сменил|поменял|обновил)[а-яё]*|(?:смен[аеуы]|изменени[еяю])\s+(?:банковск[а-яё]*\s+)?реквизит|(?:нов|друг)[а-яё]*\s+(?:расч[её]тн[а-яё]*\s+сч[её]т|р\/с)|сменил[а-яё]*\s+банк|(?:нов|друг)[а-яё]*\s+банк|от\s+другой\s+(?:фирмы|организации|компании)|на\s+(?:р\/с|сч[её]т)\s+(?:наш[а-яё]*\s+)?(?:партн[её]р|друг[а-яё]*\s+(?:организац|компани|фирм)|треть)|в\s+пользу\s+(?:ООО|АО|ИП|друг|треть)|(?:перевод[а-яё]*\s+)?на\s+(?:личн[а-яё]*\s+|банковск[а-яё]*\s+)?карт[уыеа](?![а-яё])|номер\s+карты|(?:оплат[а-яё]*|платеж[а-яё]*|платёж[а-яё]*|деньги)\s+(?:теперь\s+|с\s+\d{1,2}\.\d{1,2}\s+)?принима[а-яё]*\s+(?:ООО|АО|ИП|друг|нов|треть)|сч[её]та\s+(?:теперь\s+)?выставля[а-яё]*\s+(?:ООО|АО|ИП)/i.exec(
      text,
    ) ??
    // «получатель платежа теперь ИП …», «платёжные данные обновлены», «через платёжного агента»,
    // «через СБП по номеру телефона», «права требования уступлены», «новому кредитору», факторинг
    /получател[ья]\s+(?:платеж[а-яё]*|платёж[а-яё]*|средств|денег)\s+(?:теперь|изменил[а-яё]*|сменил[а-яё]*|друг[а-яё]*|нов[а-яё]*|[:—-]|(?:ООО|АО|ИП))|(?:платёжн|платежн)[а-яё]*\s+данн[а-яё]*\s+(?:обновл|изменил|сменил|поменял|нов)|(?:нов|друг)[а-яё]*\s+(?:платёжн|платежн)[а-яё]*\s+данн|через\s+(?:наш[а-яё]*\s+)?(?:платёжн[а-яё]*\s+|платежн[а-яё]*\s+)?агент|(?<![а-яё])СБП(?![а-яё])|по\s+номеру\s+телефона|прав[оа]?\s+требовани[а-яё]*\s+(?:по\s+сч[её]т[а-яё]*\s+\S+\s+)?(?:уступ|переда)|уступк[а-яё]*\s+прав|нов[а-яё]*\s+кредитор|факторинг/i.exec(text);
  // «наши реквизиты не менялись», «расчётный счёт прежний»: отрицание смены, если нового номера счёта не дают
  // (предупреждение о мошенниках упоминает «письма о смене реквизитов», но само сменой не является)
  const rqDenied =
    /(?:реквизит[а-яё]*|расч[её]тн[а-яё]*\s+сч[её]т|р\/с|банк)[^.!\n]{0,20}?\s(?:не\s+(?:менял|изменил|поменял)[а-яё]*|прежн[а-яё]*|т(?:е|от)\s+же|остал[а-яё]*\s+прежн)|не\s+(?:менял|изменил|поменял)[а-яё]*\s+(?:реквизит|банк|расч)/i.test(text) &&
    !/(?:нов|друг)[а-яё]*\s+(?:реквизит|расч[её]тн|р\/с|банк)[^.]{0,60}\d{20}/i.test(text);
  const rq = rqDenied ? null : rqFound;
  if (rq) spans.requisites = span(rq);
  const rs = /повторно|копи[яюи]\s+сч[её]т|дубликат/i.exec(text);
  if (rs) spans.resend = span(rs);
  const ac = /(?:по\s+)?допсоглашени[а-яё]*(?:\s+от\s+(\d{1,2}\.\d{1,2}))?|по\s+новому\s+прайсу|новая\s+цена|как\s+договаривались|согласно\s+договор[её]нност[а-яё]*/i.exec(text);
  if (ac) spans.approvalClaim = span(ac);
  const pr = /(?:привез[её]м|отгрузим|доставим|поставим|довез[её]м)[^.]*/i.exec(text);
  if (pr) spans.promise = span(pr);

  const isBuyerNote = s.domain === COMPANY_DOMAIN;
  // «исправленный», «исправлен» (глагол), «скорректированный», «corrected invoice»
  const isCorrection = /исправлен|скорректирован|откорректирован|\bcorrected\b/i.test(text);
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
    currency,
    discountPct,
    resend: !!rs,
    approvalClaim: ac ? ac[0] : null,
    approvalClaimDate: ac?.[1] ? ac[1].split(".").map((p) => p.padStart(2, "0")).join(".") : null,
    promise: pr ? pr[0].trim() : null,
    // о дате или факте оплаты: «когда ждать оплату», «оплачен ли счёт», «прошёл ли платёж», «статус оплаты»
    asksPaymentDate: /дат[а-яё]*\s+оплат|когда\s+(?:ждать\s+|ожидать\s+|будет\s+|планируете\s+)?оплат|оплачен[аоы]?\s+ли|ли\s+оплачен|прош[её]л\s+ли\s+(?:платёж|платеж|оплата)|статус\s+оплат/i.test(text),
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
