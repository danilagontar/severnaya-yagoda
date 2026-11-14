// Детерминированная сверка счетов: заказ (ERP) + согласования (Directum RX) + приёмка + счёт.
// Все суммы считает только этот код. LLM сюда не вызывается.

import { extractByRules, COMPANY_DOMAIN } from "./extract";
import type {
  Addressee,
  Approval,
  CaseData,
  CompareRow,
  Extracted,
  Finding,
  Letter,
  Order,
  Result,
  Verdict,
} from "./types";

export type Extractor = (text: string, sender: string) => Extracted;

const EPS = 0.005;
const CFO = "Финансовый директор";
const WAREHOUSE = "Начальник склада";
const TREASURER = "Казначей";

// ---------- утилиты ----------

export const rub = (n: number | null | undefined): string =>
  n === null || n === undefined
    ? "нет"
    : n.toLocaleString("ru-RU", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }) + " ₽";
const num = (n: number) => n.toLocaleString("ru-RU", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
const round2 = (n: number) => Math.round(n * 100) / 100;
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[«»"]/g, "").replace(/\s+/g, " ").trim();

function parseDate(d: string | null | undefined, year = 2026): number | null {
  if (!d) return null;
  const m = d.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?/);
  if (!m) return null;
  return Date.UTC(m[3] ? Number(m[3]) : year, Number(m[2]) - 1, Number(m[1]));
}

export function normInvoiceNo(no: string): string {
  return no.replace(/\/\d+$/, "").replace(/^0+(?=\d)/, "");
}

// ---------- согласования ----------

export interface ParsedApproval extends Approval {
  signed: boolean;
  newPrice: number | null;
  oldPrice: number | null;
  newQty: number | null;
  effectiveFrom: string | null;
}

export function parseApproval(a: Approval): ParsedApproval {
  const pr = a.text.match(/(\d+(?:,\d+)?)\s*₽[^.]*?вместо\s*(\d+(?:,\d+)?)\s*₽/);
  const q = a.text.match(/увеличено\s+с\s+(\d+)\s+до\s+(\d+)/i) ?? a.text.match(/уменьшено\s+с\s+(\d+)\s+до\s+(\d+)/i);
  const from = a.text.match(/с\s+(\d{2}\.\d{2}\.\d{4})/);
  return {
    ...a,
    signed: /^подписано/i.test(a.status.trim()),
    newPrice: pr ? Number(pr[1].replace(",", ".")) : null,
    oldPrice: pr ? Number(pr[2].replace(",", ".")) : null,
    newQty: q ? Number(q[2]) : null,
    effectiveFrom: from ? from[1] : null,
  };
}

// ---------- материалы ----------

const SYNONYMS: [RegExp, string][] = [
  [/риббон[а-яё]*/gi, "лента термотрансферная"],
  [/гофрокороб[а-яё]*/gi, "короб"],
  [/термоэтикетк[а-яё]*/gi, "этикетка термо"],
  [/короба(?![а-яё])|коробки|коробок/gi, "короб"],
  [/стретч/gi, "стрейч"],
  [/скотч[а-яё]*/gi, "лента клейкая"],
];

function matTokens(s: string) {
  const t = norm(s);
  const nums = (t.match(/\d+(?:[.,]\d+)?/g) ?? []).map((x) => x.replace(",", "."));
  const stems = (t.match(/[а-яa-z]{4,}/g) ?? []).map((w) => w.slice(0, 5));
  return { nums, stems };
}

export function materialMatch(orderMat: string, invoiceMat: string | null): { level: "exact" | "synonym" | "partial" | "none"; synonym?: string } {
  if (!invoiceMat) return { level: "none" };
  let mapped = invoiceMat;
  let synonym: string | undefined;
  for (const [re, to] of SYNONYMS) {
    if (re.test(mapped)) {
      re.lastIndex = 0;
      synonym = mapped.match(re)?.[0];
      mapped = mapped.replace(re, to);
    }
    re.lastIndex = 0;
  }
  const o = matTokens(orderMat);
  const i = matTokens(mapped);
  const wordOk = i.stems.some((s) => o.stems.includes(s));
  const numsOk =
    i.nums.length === 0 || o.nums.length === 0
      ? true
      : o.nums.every((n) => i.nums.includes(n)) || i.nums.every((n) => o.nums.includes(n));
  const anyNum = i.nums.some((n) => o.nums.includes(n));
  if (wordOk && numsOk && (i.nums.length === 0 || anyNum)) return { level: synonym ? "synonym" : "exact", synonym };
  if (wordOk || anyNum) return { level: "partial", synonym };
  return { level: "none" };
}

// ---------- поставщики ----------

function resolveSupplier(ex: Extracted, orders: Order[]): { status: Result["supplierStatus"]; name: string | null; base?: string } {
  if (ex.senderDomain === COMPANY_DOMAIN) return { status: "internal", name: ex.senderName };
  const suppliers = [...new Set(orders.map((o) => o.supplier))];
  const n = ex.senderName ? norm(ex.senderName) : null;
  if (n) {
    const exact = suppliers.find((s) => norm(s) === n);
    if (exact) return { status: "known", name: exact };
    const look = suppliers.find((s) => n.includes(norm(s)) || norm(s).includes(n));
    if (look) return { status: "lookalike", name: ex.senderName, base: look };
  }
  return { status: "unknown", name: ex.senderName };
}

// ---------- привязка к заказу по признакам (П-1) ----------

function bindByAttributes(supplier: string, ex: Extracted, orders: Order[]): { order: Order | null; score: number } {
  const cands = orders.filter((o) => o.supplier === supplier);
  const scored = cands
    .map((o) => {
      let score = 0;
      const mm = materialMatch(o.material, ex.material);
      if (mm.level === "exact" || mm.level === "synonym") score += 2;
      else if (mm.level === "partial") score += 0.5;
      const q = convertQty(ex, o);
      if (q && Math.abs(q.qty - o.ordered) < EPS) score += 1;
      if (ex.orderDateRef && o.date.startsWith(ex.orderDateRef)) score += 1;
      if (ex.price !== null && q && Math.abs(q.price - o.price) < EPS) score += 0.5;
      return { o, score };
    })
    .sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < 2) return { order: null, score: scored[0]?.score ?? 0 };
  if (scored[1] && scored[1].score === scored[0].score) return { order: null, score: scored[0].score };
  return { order: scored[0].o, score: scored[0].score };
}

// ---------- пересчёт фасовки (П-7) ----------

function convertQty(ex: Extracted, o: Order): { qty: number; price: number; text: string | null } | null {
  if (ex.qty === null || ex.price === null) return null;
  const ou = o.unit;
  if (ex.pack) {
    const { count, perPack, packUnit, innerUnit } = ex.pack;
    if (innerUnit === ou) {
      const qty = count * perPack;
      const price = ex.pricePer === "pack" ? ex.price / perPack : ex.price;
      const short = ({ мешок: "меш.", рул: "рул.", рулон: "рул.", пачка: "пач.", упаковка: "упак." } as Record<string, string>)[packUnit] ?? packUnit;
      const one = ({ мешок: "мешок", рул: "рулон", рулон: "рулон", пачка: "пачку", упаковка: "упаковку" } as Record<string, string>)[packUnit] ?? packUnit;
      const text =
        `${num(count)} ${short} × ${num(perPack)} ${innerUnit} = ${num(qty)} ${ou}` +
        (ex.pricePer === "pack" ? `; ${num(ex.price)} ₽ за ${one} ÷ ${num(perPack)} = ${num(round2(price))} ₽/${ou}` : "");
      return { qty, price, text };
    }
    if (ou === "рул" && (packUnit === "рул" || packUnit === "рулон")) return { qty: count, price: ex.price, text: null };
    return null;
  }
  if (ex.unit === ou || (ex.unit === "рулон" && ou === "рул")) return { qty: ex.qty, price: ex.price, text: null };
  return null;
}

// ---------- основной проход ----------

interface Claim {
  id: string;
  qty: number;
}

export function reconcileAll(data: CaseData, letters: Letter[] = data.letters, extractor: Extractor = extractByRules, newIds: Set<string> = new Set()): Result[] {
  const orders = data.orders;
  const approvals = data.approvals.map(parseApproval);
  const snapshot = parseDate(data.meta.snapshot)!;
  const byId = new Map<string, Result>();
  const results: Result[] = [];
  const invoiceIndex = new Map<string, string>(); // поставщик|номер → id актуальной версии
  const claims = new Map<string, Claim[]>(); // заказ → выставленные количества
  const domains = new Map<string, Set<string>>(); // поставщик → домены почты, с которых он писал

  // Сначала все счета (в порядке поступления), затем письма-контекст: так письмо
  // о реквизитах влияет на счёт, даже если пришло раньше него.
  const exs = letters.map((l) => ({ l, ex: extractor(l.text, l.sender) }));
  const invoices = exs.filter((x) => x.ex.kind !== "letter");
  const notes = exs.filter((x) => x.ex.kind === "letter");

  const base = (l: Letter, ex: Extracted): Result => ({
    id: l.id,
    received: l.received,
    sender: l.sender,
    text: l.text,
    ex,
    supplier: null,
    supplierStatus: "unknown",
    orderId: null,
    binding: "none",
    invoiced: ex.total,
    due: null,
    payNow: 0,
    verdict: "ask",
    headline: "",
    findings: extractionNotes(ex),
    addressees: [],
    related: [],
    prevented: [],
    deferred: 0,
    conversion: null,
    compare: [],
    orderSummary: null,
    isNew: newIds.has(l.id),
  });

  const addAddr = (r: Result, a: Addressee) => {
    if (!r.addressees.some((x) => x.role === a.role && x.name === a.name)) r.addressees.push(a);
  };
  const buyerOf = (o: Order | null | undefined, reason: string): Addressee =>
    o ? { role: "buyer", name: o.buyer, reason } : { role: "procurement", name: "Отдел закупок", reason };
  const link = (a: Result, b: Result) => {
    if (!a.related.includes(b.id)) a.related.push(b.id);
    if (!b.related.includes(a.id)) b.related.push(a.id);
  };

  for (const { l, ex } of invoices) {
    const r = base(l, ex);
    results.push(r);
    byId.set(r.id, r);

    const sup = resolveSupplier(ex, orders);
    r.supplier = sup.name;
    r.supplierStatus = sup.status;

    // --- 0. Два независимых разбора письма (правила и LLM) не сошлись в поле, влияющем на сумму или привязку
    const cc = ex.crossCheck;
    if (cc) {
      for (const f of cc.fields) {
        if (f.critical && f.status === "diff")
          r.findings.push({ rule: "Разбор", level: "ask", text: `${f.label}: правила прочитали «${f.rules}», ${cc.model} «${f.llm}». Сверка идёт по правилам; проверьте письмо.` });
        if (f.status === "llm-rejected")
          r.findings.push({ rule: "Разбор", level: "info", text: `${cc.model} предложил «${f.llm}» в поле «${f.label}», но такого числа в письме нет. Значение отклонено.` });
      }
    }

    // --- 1. Поставщик и реквизиты (П-2)
    if (sup.status === "lookalike" || (sup.status === "known" && ex.requisitesChange)) {
      const baseSupplier = sup.base ?? sup.name!;
      const probable = ex.orderNo ? orders.find((o) => o.id === ex.orderNo) ?? null : bindByAttributes(baseSupplier, ex, orders).order;
      r.orderId = probable?.id ?? null;
      r.binding = probable ? "probable" : "none";
      r.verdict = "stop";
      r.due = 0;
      const knownDomains = [...(domains.get(baseSupplier) ?? [])];
      if (sup.status === "lookalike") {
        r.findings.push({
          rule: "П-2",
          level: "stop",
          text: `Отправитель «${sup.name}» не совпадает с поставщиком в заказе: «${baseSupplier}». Счета принимают только от поставщика из заказа.`,
          source: probable?.id,
        });
        if (ex.senderDomain && knownDomains.length && !knownDomains.includes(ex.senderDomain))
          r.findings.push({ rule: "П-2", level: "stop", text: `Почта с другого домена: ${ex.senderDomain}; «${baseSupplier}» писал с ${knownDomains.join(", ")}.` });
      }
      if (ex.requisitesChange)
        r.findings.push({ rule: "П-2", level: "stop", text: "Просят платить по новым реквизитам. Подписанного допсоглашения о смене получателя в Directum RX нет." });
      r.headline = sup.status === "lookalike" ? "Счёт от другого юрлица с похожим названием и новыми реквизитами: признаки подмены получателя" : "Счёт с новыми реквизитами без допсоглашения";
      if (ex.total) r.prevented.push({ category: "fraud", amount: ex.total });
      addAddr(r, buyerOf(probable, "проверить, кто выставил счёт"));
      addAddr(r, { role: "cfo", name: CFO, reason: "смена получателя платежа (П-2)" });
      if (probable) {
        const orig = results.find((x) => x !== r && x.orderId === probable.id && x.supplierStatus === "known" && ex.invoiceNo && x.ex.invoiceNo && normInvoiceNo(x.ex.invoiceNo) === normInvoiceNo(ex.invoiceNo));
        if (orig) {
          link(r, orig);
          r.findings.push({ rule: "П-3", level: "info", text: `Номер и сумма повторяют счёт ${orig.ex.invoiceNo} настоящего поставщика (${orig.id}).`, source: orig.id });
        }
      }
      r.compare = compareRows(r, probable, null, approvals, sup.status === "lookalike" ? baseSupplier : null);
      continue;
    }

    if (sup.status === "known" && ex.senderDomain) {
      if (!domains.has(sup.name!)) domains.set(sup.name!, new Set());
      domains.get(sup.name!)!.add(ex.senderDomain);
    }

    // --- 2. Версии и дубли (П-3), номера у разных поставщиков (П-1)
    const key = ex.invoiceNo ? `${sup.name}|${normInvoiceNo(ex.invoiceNo)}` : null;
    const prevId = key ? invoiceIndex.get(key) : undefined;
    const prev = prevId ? byId.get(prevId) : undefined;
    if (prev && ex.kind === "correction") {
      prev.verdict = "duplicate";
      prev.replacedBy = r.id;
      prev.payNow = 0;
      prev.due = null;
      prev.prevented = [];
      prev.deferred = 0;
      prev.headline = `Заменён исправленной версией ${r.id}`;
      prev.findings = [{ rule: "П-3", level: "info", text: `Исправленный счёт ${ex.invoiceNo} (${r.id}) заменяет эту версию.`, source: r.id }];
      prev.addressees = [];
      if (prev.orderId) claims.set(prev.orderId, (claims.get(prev.orderId) ?? []).filter((c) => c.id !== prev.id));
      link(r, prev);
      r.findings.push({ rule: "П-3", level: "info", text: `Исправленная версия: заменяет ${prev.id}.`, source: prev.id });
    } else if (prev || ex.kind === "copy") {
      if (prev) {
        r.verdict = "duplicate";
        r.duplicateOf = prev.id;
        r.orderId = prev.orderId;
        r.binding = prev.binding;
        r.supplier = sup.name;
        r.due = 0;
        const shown = ex.invoiceNo !== prev.ex.invoiceNo ? `«${ex.invoiceNo}» это тот же счёт ${prev.ex.invoiceNo}, номер записан иначе` : `счёт ${ex.invoiceNo} уже получен`;
        r.findings.push({ rule: "П-3", level: "info", text: `Копия: ${shown} (${prev.id}).`, source: prev.id });
        r.headline = `Копия счёта ${prev.ex.invoiceNo} (${prev.id}), не отдельный документ`;
        const amount = ex.total ?? prev.invoiced ?? 0;
        if (amount) r.prevented.push({ category: "duplicate", amount });
        link(r, prev);
        if (ex.asksPaymentDate) {
          addAddr(r, { role: "treasurer", name: TREASURER, reason: `дата оплаты после решения по ${prev.id}` });
          r.findings.push({ rule: "П-9", level: "info", text: `Поставщик спрашивает дату оплаты. Ответ после решения по ${prev.id}.` });
        }
        const o = orders.find((x) => x.id === r.orderId) ?? null;
        r.compare = compareRows(r, o, null, approvals, null);
        continue;
      }
      r.findings.push({ rule: "П-3", level: "ask", text: "Письмо называет счёт повторным, но исходный счёт в очереди не найден. Проверяем как новый." });
    }
    if (ex.invoiceNo) {
      const sameNoOther = results.filter((x) => x !== r && x.supplier && x.supplier !== sup.name && x.ex.invoiceNo && normInvoiceNo(x.ex.invoiceNo) === normInvoiceNo(ex.invoiceNo!) && x.supplierStatus === "known");
      for (const x of sameNoOther)
        r.findings.push({ rule: "П-1", level: "info", text: `Номер ${ex.invoiceNo} есть и у «${x.supplier}» (${x.id}), но это другой поставщик, не дубль.`, source: x.id });
      if (key) invoiceIndex.set(key, r.id);
    }

    // --- 3. Поставщик не из заказов
    if (sup.status !== "known") {
      r.verdict = "ask";
      r.due = null;
      r.headline = "Поставщика нет в заказах, счёт не к чему привязать";
      r.findings.push({ rule: "П-2", level: "ask", text: `«${sup.name ?? "отправитель не указан"}» не найден среди поставщиков в заказах ERP.` });
      addAddr(r, buyerOf(null, "есть ли заказ у этого поставщика"));
      r.compare = compareRows(r, null, null, approvals, null);
      continue;
    }

    // --- 4. Привязка к заказу (П-1)
    let order: Order | null = null;
    if (ex.orderNo) {
      order = orders.find((o) => o.id === ex.orderNo) ?? null;
      if (order) r.binding = "number";
      else r.findings.push({ rule: "П-1", level: "ask", text: `Заказ ${ex.orderNo} не найден в выгрузке ERP.` });
      if (order && order.supplier !== sup.name) {
        r.findings.push({ rule: "П-1", level: "ask", text: `${order.id} оформлен на «${order.supplier}», а счёт от «${sup.name}».`, source: order.id });
        order = null;
        r.binding = "none";
      }
    }
    if (!order) {
      const b = bindByAttributes(sup.name!, ex, orders);
      if (b.order) {
        order = b.order;
        r.binding = "attributes";
        const why = [ex.material && "материал", "количество", ex.orderDateRef && `дата заказа ${ex.orderDateRef}`].filter(Boolean).join(", ");
        r.findings.push({ rule: "П-1", level: "info", text: `Номера заказа в счёте нет. Найден ${order.id} по поставщику: ${why}.`, source: order.id });
      }
    }
    r.orderId = order?.id ?? null;
    if (!order) {
      r.verdict = "ask";
      r.headline = "Не удалось однозначно найти заказ";
      r.findings.push({ rule: "П-1", level: "ask", text: `У «${sup.name}» несколько или ни одного подходящего заказа, нужен номер заказа.` });
      addAddr(r, { role: "procurement", name: orders.find((o) => o.supplier === sup.name)?.buyer ?? "Отдел закупок", reason: "уточнить номер заказа" });
      r.compare = compareRows(r, null, null, approvals, null);
      continue;
    }

    // --- 5. Материал (П-7)
    const mm = materialMatch(order.material, ex.material);
    if (mm.level === "synonym")
      r.findings.push({ rule: "П-7", level: "info", text: `«${mm.synonym}» у поставщика = «${order.material}» в ERP.`, source: order.id });
    else if (mm.level === "none" || (mm.level === "partial" && r.binding === "number"))
      r.findings.push({ rule: "П-7", level: "ask", text: `Материал в счёте («${ex.material ?? "не указан"}») не похож на материал заказа («${order.material}»).`, source: order.id });

    // --- 6. Пересчёт в единицы заказа (П-7)
    const conv = convertQty(ex, order);
    if (!conv) {
      r.verdict = "ask";
      r.headline = "Не удалось пересчитать количество в единицы заказа";
      r.findings.push({ rule: "П-7", level: "ask", text: `Счёт в «${ex.unit ?? "?"}», заказ в «${order.unit}», фасовка в счёте не указана.`, source: order.id });
      addAddr(r, buyerOf(order, "уточнить фасовку"));
      r.compare = compareRows(r, order, null, approvals, null);
      continue;
    }
    r.conversion = conv.text;
    if (conv.text) r.findings.push({ rule: "П-7", level: "info", text: `Пересчёт фасовки: ${conv.text}.` });

    // --- 7. Арифметика итога (П-8)
    let arithmeticError = false;
    const calc = round2(ex.qty! * ex.price!);
    if (ex.total !== null && Math.abs(calc - ex.total) > EPS) {
      arithmeticError = true;
      r.findings.push({ rule: "П-8", level: "return", text: `${num(ex.qty!)} × ${num(ex.price!)} = ${rub(calc)}, а в счёте итог ${rub(ex.total)}.` });
      if (ex.total > calc) r.prevented.push({ category: "arithmetic", amount: round2(ex.total - calc) });
      addAddr(r, { role: "supplier", name: sup.name!, email: ex.senderEmail ?? undefined, reason: "исправить итог счёта" });
    }

    // --- 8. Цена с учётом согласований (П-6)
    const ownApprovals = approvals.filter((a) => a.order === order!.id);
    const acceptDate = parseDate(order.lastAcceptance) ?? snapshot;
    let effPrice = order.price;
    let priceSource = `${order.id}, ERP`;
    let usedApproval: ParsedApproval | null = null;
    const priceNotes: Finding[] = [];
    for (const a of ownApprovals.filter((x) => x.newPrice !== null)) {
      const from = parseDate(a.effectiveFrom);
      if (!a.signed) {
        priceNotes.push({ rule: "П-6", level: "ask", text: `${a.id} (${num(a.newPrice!)} ₽) в статусе «${a.status}». Неподписанное согласование не действует.`, source: a.id });
      } else if (from !== null && acceptDate < from) {
        priceNotes.push({ rule: "П-6", level: "ask", text: `${a.id}: ${num(a.newPrice!)} ₽ действует только с ${a.effectiveFrom}, а поставка принята ${order.lastAcceptance}, поэтому цена ${num(order.price)} ₽.`, source: a.id });
      } else {
        effPrice = a.newPrice!;
        priceSource = `${a.id}, подписано`;
        usedApproval = a;
      }
    }
    if (ex.approvalClaim && !usedApproval) {
      const claimDate = parseDate(ex.approvalClaimDate);
      const foreign = claimDate !== null ? approvals.filter((a) => parseDate(a.date) === claimDate && a.order !== order!.id) : [];
      for (const f of foreign)
        priceNotes.push({ rule: "П-6", level: "ask", text: `Поставщик ссылается на «${ex.approvalClaim}». Это ${f.id}, и оно относится к ${f.order}, а не к ${order.id}.`, source: f.id });
      if (!foreign.length && !ownApprovals.some((a) => a.newPrice !== null))
        priceNotes.push({ rule: "П-6", level: "ask", text: `Поставщик ссылается на «${ex.approvalClaim}», но подписанного согласования цены по ${order.id} нет.` });
    }
    if (conv.price > effPrice + EPS) {
      r.findings.push(...priceNotes);
      const over = round2((conv.price - effPrice) * conv.qty);
      r.findings.push({
        rule: "П-6",
        level: "ask",
        text: `Цена в счёте ${num(round2(conv.price))} ₽/${order.unit}, действующая: ${num(effPrice)} ₽ (${priceSource}). Разница ${rub(over)}.`,
        short: `цена выше действующей на ${rub(over)}`,
        source: usedApproval?.id ?? order.id,
      });
      r.prevented.push({ category: "price", amount: over });
      addAddr(r, buyerOf(order, "цена выше действующей (П-6)"));
    } else if (usedApproval && Math.abs(usedApproval.newPrice! - order.price) > EPS) {
      r.findings.push({ rule: "П-6", level: "info", text: `Цена ${num(effPrice)} ₽ по подписанному ${usedApproval.id}, хотя в ERP ещё ${num(order.price)} ₽.`, source: usedApproval.id });
    }
    const payPrice = Math.min(conv.price, effPrice);

    // --- 9. Количество против принятого (П-4, П-5, П-6)
    const qtyApproval = ownApprovals.find((a) => a.signed && a.newQty !== null);
    const approvedQty = qtyApproval?.newQty ?? order.ordered;
    const before = (claims.get(order.id) ?? []).reduce((s, c) => s + c.qty, 0);
    const limit = Math.min(order.accepted, approvedQty);
    const remaining = Math.max(0, limit - before);
    const billable = Math.min(conv.qty, remaining);
    if (qtyApproval) r.findings.push({ rule: "П-6", level: "info", text: `${qtyApproval.id}: количество по заказу ${num(approvedQty)} ${order.unit} (в ERP ${num(order.ordered)}).`, source: qtyApproval.id });

    if (order.accepted > approvedQty && conv.qty > approvedQty - before + EPS) {
      r.findings.push({
        rule: "П-6",
        level: "ask",
        text: `Склад принял ${num(order.accepted)} ${order.unit} при заказе ${num(approvedQty)}, согласования на +${num(order.accepted - approvedQty)} нет. К оплате ${num(billable)} ${order.unit}.`,
        short: `принято ${num(order.accepted)} при заказе ${num(approvedQty)}, излишек не согласован`,
        source: order.id,
      });
      addAddr(r, buyerOf(order, "согласовать или вернуть излишек"));
      addAddr(r, { role: "warehouse", name: WAREHOUSE, reason: "почему принято сверх заказа" });
    } else if (conv.qty > remaining + EPS) {
      if (order.accepted === 0) {
        r.findings.push({
          rule: "П-4",
          level: "ask",
          text: `По ${order.id} на складе ничего не принято (срез ${data.meta.snapshot}). Счёт на ${num(conv.qty)} ${order.unit}.`,
          short: `ничего не принято, счёт на ${num(conv.qty)} ${order.unit}`,
          source: order.id,
        });
      } else {
        const parts = [`принято ${num(order.accepted)}`];
        if (before) parts.push(`уже выставлено ${num(before)}`);
        r.findings.push({
          rule: "П-4",
          level: "ask",
          text: `Счёт на ${num(conv.qty)} ${order.unit}, к оплате доступно ${num(remaining)} (${parts.join(", ")}).`,
          short: before ? `к оплате доступно ${num(remaining)} из ${num(conv.qty)}` : `принято ${num(order.accepted)} из ${num(conv.qty)}`,
          source: order.id,
        });
      }
      if (ex.promise) r.findings.push({ rule: "П-4", level: "info", text: `Обещание «${ex.promise}» приёмкой не считается.` });
      // П-5: только если часть счёта в пределах заказа, но ещё не принята (это и есть предоплата).
      // Если всё принятое уже выставлено и счёт выходит за заказ: это лишний счёт (П-3, сводка по заказу ниже).
      const prepaid = Math.min(before + conv.qty, approvedQty) > Math.max(before, order.accepted) + EPS;
      if (prepaid) {
        r.findings.push({ rule: "П-5", level: "ask", text: "Предоплата возможна только по договору. Условий в выгрузке нет, запросить у закупщика.", short: "предоплата не подтверждена договором" });
        addAddr(r, buyerOf(order, "условия договора о предоплате (П-5)"));
      } else {
        addAddr(r, buyerOf(order, "счёт сверх заказа (П-3)"));
      }
    }
    r.deferred = round2((conv.qty - billable) * payPrice);

    // --- итог
    r.due = round2(billable * payPrice);
    (claims.get(order.id) ?? claims.set(order.id, []).get(order.id)!).push({ id: r.id, qty: conv.qty });
    r.compare = compareRows(r, order, conv, approvals, null, { effPrice, priceSource, approvedQty, billable });
    finalizeVerdict(r, arithmeticError);
  }

  // --- в одном письме несколько счетов: разобран только первый, остальные не должны потеряться молча
  for (const r of results) {
    const more = r.ex.otherInvoices ?? [];
    if (!more.length) continue;
    const text = `В письме несколько счетов: ${[r.ex.invoiceNo, ...more].join(", ")}. Разобран только счёт ${r.ex.invoiceNo}, остальные нужно завести отдельными документами и проверить.`;
    r.findings.unshift({ rule: "П-1", level: "ask", text });
    if (r.verdict === "pay" || r.verdict === "duplicate") {
      r.verdict = "ask";
      r.payNow = 0;
      r.headline = text;
      r.duplicateOf = undefined;
      r.prevented = [];
    }
  }

  // --- сводка по заказу: «выставлено X из Y»
  for (const o of orders) {
    const list = results.filter((r) => r.orderId === o.id && r.verdict !== "duplicate" && r.verdict !== "stop" && r.binding !== "probable");
    if (!list.length) continue;
    const approvedQty = approvals.find((a) => a.order === o.id && a.signed && a.newQty !== null)?.newQty ?? o.ordered;
    const sum = (claims.get(o.id) ?? []).reduce((s, c) => s + c.qty, 0);
    for (const r of results.filter((x) => x.orderId === o.id)) {
      r.orderSummary = `По ${o.id} выставлено ${num(sum)} из ${num(approvedQty)} ${o.unit}, принято ${num(o.accepted)}`;
      for (const x of list) if (x !== r && (r.verdict !== "duplicate" || x.id === r.duplicateOf)) link(r, x);
    }
    if (list.length > 1 && sum > approvedQty + EPS) {
      // В «вопрос» уходят только счета, которые не уместились в заказ и приёмку; ранние счета в пределах заказа остаются к оплате.
      const over = list.filter((x) => x.deferred > EPS || x.verdict !== "pay");
      const overIds = list.filter((x) => x.deferred > EPS).map((x) => x.id);
      const text = `По ${o.id} на ${num(approvedQty)} ${o.unit} выставлено ${num(sum)}: счета ${list.map((x) => x.id).join(", ")}.`;
      for (const r of list) {
        if (over.includes(r)) r.findings.push({ rule: "П-3", level: "ask", text, short: `по ${o.id} выставлено ${num(sum)} из ${num(approvedQty)}`, source: o.id });
        else r.findings.push({ rule: "П-3", level: "info", text: `${text} Этот счёт в пределах заказа и приёмки${overIds.length ? `, лишнее в ${overIds.join(", ")}` : ""}.`, source: o.id });
      }
    }
  }

  // --- письма-контекст
  for (const { l, ex } of notes) {
    const r = base(l, ex);
    r.invoiced = null;
    results.push(r);
    byId.set(r.id, r);
    const sup = resolveSupplier(ex, orders);
    r.supplier = sup.name;
    r.supplierStatus = sup.status;
    r.verdict = "letter";

    // к какому счёту относится
    let targets: Result[] = [];
    if (ex.invoiceRef) {
      targets = results.filter((x) => x.ex.kind !== "letter" && x.ex.invoiceNo && normInvoiceNo(x.ex.invoiceNo) === normInvoiceNo(ex.invoiceRef!) && (sup.status !== "known" || x.supplier === sup.name) && x.verdict !== "duplicate");
    }
    if (!targets.length && ex.orderNo) {
      targets = results.filter((x) => x.ex.kind !== "letter" && x.orderId === ex.orderNo && x.verdict !== "duplicate" && x.binding !== "probable");
      r.orderId = ex.orderNo;
    }
    if (targets[0]) r.orderId = r.orderId ?? targets[0].orderId;
    for (const t of targets) link(r, t);
    const order = orders.find((o) => o.id === r.orderId) ?? null;
    const tIds = targets.map((t) => t.id).join(", ");

    if (ex.topic === "requisites") {
      r.verdict = "stop";
      r.headline = `Смена реквизитов письмом без допсоглашения${tIds ? `, к ${tIds}` : ""}`;
      r.findings.push({ rule: "П-2", level: "stop", text: "Смену получателя или банковских реквизитов оформляют подписанным допсоглашением в Directum RX. Письмо им не является, реквизиты не менять." });
      addAddr(r, buyerOf(order, "подтвердить смену реквизитов"));
      addAddr(r, { role: "cfo", name: CFO, reason: "смена реквизитов (П-2)" });
      for (const t of targets) {
        t.findings.unshift({ rule: "П-2", level: "ask", text: `${r.id}: поставщик просит платить на новые реквизиты без допсоглашения. Платёж не готовим до ответа закупщика и ФД.`, source: r.id });
        addAddr(t, buyerOf(order, "подтвердить реквизиты"));
        addAddr(t, { role: "cfo", name: CFO, reason: "смена реквизитов (П-2)" });
        if (t.verdict === "pay") {
          t.verdict = "ask";
          t.headline = `Сверка пройдена, но ${r.id} просит сменить реквизиты, платёж задержан`;
        }
        t.payNow = 0;
      }
    } else if (ex.topic === "delivery-promise") {
      r.headline = `Поставщик обещает поставку${tIds ? `, контекст к ${tIds}` : ""}`;
      r.findings.push({ rule: "П-4", level: "info", text: "Обещание привезти не является приёмкой: оплату готовят за количество, проведённое на складе." });
      if (/реестр|оплат/i.test(l.text)) r.findings.push({ rule: "П-4", level: "info", text: "Просьбу включить в реестр выполнить нельзя, пока нет приёмки." });
      for (const t of targets) t.findings.push({ rule: "П-4", level: "info", text: `${r.id}: «${ex.promise}», поставка ещё не принята.`, source: r.id });
    } else if (ex.topic === "buyer-note") {
      r.headline = `Комментарий закупщика${tIds ? ` к ${tIds}` : ""}`;
      r.findings.push({ rule: "П-6", level: "info", text: "Пояснение закупщика учитывается как контекст, согласованием не является." });
      for (const t of targets) t.findings.push({ rule: "П-6", level: "info", text: `${r.id}: закупщик подтверждает: ${l.text.replace(/\s+/g, " ").slice(0, 140)}`, source: r.id });
    } else {
      r.headline = tIds ? `Письмо поставщика, контекст к ${tIds}` : "Письмо без счёта, связанный счёт не найден";
    }
    if (!targets.length && ex.topic !== "other") r.findings.push({ rule: "П-1", level: "info", text: "Связанный счёт в очереди не найден." });
    if (ex.otherInvoices?.length)
      r.findings.push({ rule: "П-1", level: "info", text: `Письмо упоминает несколько счетов: ${[ex.invoiceNo ?? ex.invoiceRef, ...ex.otherInvoices].filter(Boolean).join(", ")}.` });
    r.compare = compareRows(r, order, null, approvals, null);
  }

  // headline для счетов без явной причины
  for (const r of results) if (!r.headline) r.headline = defaultHeadline(r);

  const order = new Map(letters.map((l, i) => [l.id, i]));
  return results.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

/** Как письмо было прочитано: переслано, счёт из цитаты. Показывается в карточке. */
function extractionNotes(ex: Extracted): Finding[] {
  const out: Finding[] = [];
  if (ex.forwardedBy) out.push({ rule: "Разбор", level: "info", text: `Письмо переслано (${ex.forwardedBy}). Поставщик и счёт взяты из пересланной части.` });
  if (ex.fromQuote) out.push({ rule: "Разбор", level: "info", text: "Счёт есть только в цитате ответа поставщика: считаем это повторной отправкой." });
  return out;
}

function finalizeVerdict(r: Result, arithmeticError: boolean) {
  const has = (lvl: Finding["level"]) => r.findings.some((f) => f.level === lvl);
  let v: Verdict = "pay";
  if (has("stop")) v = "stop";
  else if (arithmeticError) v = "return";
  else if (has("ask")) v = "ask";
  r.verdict = v;
  r.payNow = v === "pay" ? r.due ?? 0 : 0;
}

/** Заголовок счёта: если причин на разные темы несколько, перечисляет все темы, а подробности остаются в «Почему так». */
function defaultHeadline(r: Result): string {
  if (r.verdict !== "pay") {
    // одна тема на правило: две причины П-6 про одну цену дают одну тему
    const byRule = new Map<string, Finding>();
    for (const f of r.findings) if (f.level !== "info" && f.level !== "ok" && !byRule.has(f.rule)) byRule.set(f.rule, f);
    const topics = [...byRule.values()];
    if (topics.length > 1) {
      // сначала темы уровня вердикта (главная причина), затем остальные, порядок внутри сохраняется
      topics.sort((a, b) => Number(b.level === r.verdict) - Number(a.level === r.verdict));
      const parts = topics.map((f) => f.short ?? f.text.replace(/\.$/, ""));
      const s = parts.join("; ");
      return s[0].toUpperCase() + s.slice(1) + ".";
    }
  }
  const main = r.findings.find((f) => f.level === r.verdict || (r.verdict === "return" && f.level === "return") || (r.verdict === "ask" && f.level === "ask"));
  if (r.verdict === "pay") {
    const info = r.findings.find((f) => f.level === "info");
    return info ? `Сверка пройдена. ${info.text}` : "Сверка пройдена: заказ, приёмка и цена сходятся";
  }
  return main?.text ?? "Требует проверки";
}

// ---------- таблица «Заказ / Согласование / Приёмка / Счёт» ----------

function compareRows(
  r: Result,
  o: Order | null,
  conv: { qty: number; price: number } | null,
  approvals: ParsedApproval[],
  lookalikeOf: string | null,
  calc?: { effPrice: number; priceSource: string; approvedQty: number; billable: number },
): CompareRow[] {
  const ex = r.ex;
  const own = o ? approvals.filter((a) => a.order === o.id) : [];
  const priceAppr = own.find((a) => a.newPrice !== null);
  const qtyAppr = own.find((a) => a.newQty !== null);
  const has = (re: RegExp) => r.findings.some((f) => f.level !== "info" && f.level !== "ok" && re.test(f.rule));
  const shortUnit = ex.unit ? ({ мешок: "меш.", рулон: "рул.", пачка: "пач.", упаковка: "упак." } as Record<string, string>)[ex.unit] ?? ex.unit : "";
  const invQty = ex.qty !== null ? `${num(ex.qty)} ${shortUnit}`.trim() + (conv && ex.pack ? ` → ${num(conv.qty)} ${o?.unit}` : "") : null;
  const invPrice = ex.price !== null ? `${num(ex.price)} ₽` + (conv && ex.pricePer === "pack" ? ` → ${num(round2(conv.price))} ₽/${o?.unit}` : "") : null;
  const apprTxt = (a?: ParsedApproval, what?: string) => (a ? `${a.id}: ${what} | ${a.signed ? "подписано" : a.status.toLowerCase()}${a.effectiveFrom ? ` | с ${a.effectiveFrom}` : ""}` : null);

  const rows: CompareRow[] = [
    {
      key: "supplier",
      label: "Поставщик",
      order: o?.supplier ?? lookalikeOf,
      approval: null,
      acceptance: null,
      invoice: r.supplier ?? ex.senderName,
      status: r.supplierStatus === "lookalike" || (ex.requisitesChange && r.ex.kind !== "letter") ? "bad" : r.supplierStatus === "known" ? "ok" : "none",
      note: ex.senderDomain ?? undefined,
    },
    {
      key: "material",
      label: "Материал",
      order: o?.material ?? null,
      approval: null,
      acceptance: null,
      invoice: ex.material,
      status: !o || !ex.material ? "none" : has(/П-7/) && r.findings.some((f) => f.rule === "П-7" && f.level === "ask") ? "warn" : r.findings.some((f) => f.rule === "П-7" && f.text.includes("у поставщика =")) ? "info" : "ok",
    },
    {
      key: "qty",
      label: "Количество",
      order: o ? `${num(o.ordered)} ${o.unit}` : null,
      approval: qtyAppr ? apprTxt(qtyAppr, `${num(qtyAppr.newQty!)} ${o!.unit}`) : null,
      acceptance: o ? `${num(o.accepted)} ${o.unit}${o.lastAcceptance ? ` | ${o.lastAcceptance.slice(0, 5)}` : ""}` : null,
      invoice: invQty,
      status: !o || ex.qty === null ? "none" : r.findings.some((f) => (f.rule === "П-4" || f.rule === "П-6" || f.rule === "П-3") && f.level === "ask" && /принят|выставлено|сверх/.test(f.text)) ? "bad" : "ok",
      note: calc && conv && calc.billable < conv.qty ? `к оплате ${num(calc.billable)} ${o?.unit}` : undefined,
    },
    {
      key: "price",
      label: "Цена за ед.",
      order: o ? `${num(o.price)} ₽` : null,
      approval: priceAppr ? apprTxt(priceAppr, `${num(priceAppr.newPrice!)} ₽`) : null,
      acceptance: null,
      invoice: invPrice,
      status: !o || ex.price === null ? "none" : r.prevented.some((p) => p.category === "price") ? "bad" : calc && calc.priceSource.includes("подписано") ? "info" : "ok",
      note: calc ? `действует ${num(calc.effPrice)} ₽ (${calc.priceSource})` : undefined,
    },
    {
      key: "total",
      label: "Сумма",
      order: o ? rub(o.ordered * o.price) : null,
      approval: null,
      acceptance: null,
      invoice: ex.total !== null ? rub(ex.total) : null,
      status: ex.total === null ? "none" : r.prevented.some((p) => p.category === "arithmetic") ? "bad" : r.due !== null && Math.abs((r.due ?? 0) - ex.total) > EPS ? "warn" : "ok",
      note: ex.qty !== null && ex.price !== null ? `${num(ex.qty)} × ${num(ex.price)} = ${rub(round2(ex.qty * ex.price))}` : undefined,
    },
  ];
  return rows;
}

// ---------- сводка ----------

export interface Summary {
  total: number;
  invoices: number;
  letters: number;
  byVerdict: Record<Verdict, number>;
  payNow: number;
  payNowCount: number;
  prevented: Record<"duplicate" | "fraud" | "price" | "arithmetic", number>;
  preventedTotal: number;
  deferred: number;
  held: number; // сверка пройдена, но платёж задержан (реквизиты)
}

export function summarize(results: Result[]): Summary {
  const byVerdict = { pay: 0, ask: 0, return: 0, duplicate: 0, stop: 0, letter: 0 } as Record<Verdict, number>;
  const prevented = { duplicate: 0, fraud: 0, price: 0, arithmetic: 0 };
  let payNow = 0,
    deferred = 0,
    held = 0;
  for (const r of results) {
    byVerdict[r.verdict]++;
    payNow += r.payNow;
    deferred += r.deferred;
    for (const p of r.prevented) prevented[p.category] += p.amount;
    if (r.verdict === "ask" && r.findings.some((f) => f.rule === "П-2") && r.due) held += r.due;
  }
  return {
    total: results.length,
    invoices: results.filter((r) => r.ex.kind !== "letter").length,
    letters: results.filter((r) => r.ex.kind === "letter").length,
    byVerdict,
    payNow: round2(payNow),
    payNowCount: byVerdict.pay,
    prevented,
    preventedTotal: round2(prevented.duplicate + prevented.fraud + prevented.price + prevented.arithmetic),
    deferred: round2(deferred),
    held,
  };
}
