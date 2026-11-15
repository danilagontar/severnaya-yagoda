// Место подключения LLM (GigaChat через серверный прокси /api/llm, см. server/ и docs/llm.md).
// LLM только (1) извлекает поля из текста письма и (2) переписывает черновик письма.
// Всё, что вернула модель, проверяется: числа должны встречаться в исходном тексте.
// При любой ошибке: откат на правила.

import { extractByRules } from "@/core/extract";
import { numbersIn, type Draft } from "@/core/drafts";
import type { CrossCheck, CrossField, Extracted, Verdict } from "@/core/types";

export type LlmMode = "rules" | "gigachat";

export async function getLlmStatus(): Promise<{ mode: LlmMode; model: string | null }> {
  try {
    const r = await fetch("/api/llm/status");
    if (!r.ok) return { mode: "rules", model: null };
    return await r.json();
  } catch {
    return { mode: "rules", model: null };
  }
}

export interface LlmUsage {
  requests: number;
  prompt: number;
  completion: number;
  total: number;
  since: string;
  last: { at: string; purpose: string; total: number } | null;
}

/** Расход токенов с момента запуска dev-сервера; balance: остаток из GigaChat (только при пакетах токенов). */
export async function getUsage(withBalance = false): Promise<{ usage: LlmUsage; balance: { ok: boolean; data?: unknown; error?: string } | null } | null> {
  try {
    const r = await fetch(`/api/llm/usage${withBalance ? "?balance=1" : ""}`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// Инструкции для модели хранятся на сервере (server/prompts.ts); отсюда уходит только название задачи и текст.
type Task = "extract" | "polish" | "polish-stop";
async function chat(task: Task, user: string): Promise<string> {
  const r = await fetch("/api/llm/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task, user }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `LLM ${r.status}`);
  return j.content as string;
}

/**
 * Два независимых разбора письма: правила (extractByRules) и GigaChat.
 * Сверка всегда идёт по полям правил; GigaChat дополняет только пустые поля
 * и только числами, которые есть в тексте. Расхождения показываются бухгалтеру
 * и переводят счёт в «вопрос» (см. reconcile.ts).
 */
export async function extractWithLlm(text: string, sender: string, model = "ИИ"): Promise<{ ex: Extracted; note: string }> {
  const base = extractByRules(text, sender);
  try {
    const raw = await chat("extract", text);
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const ex: Extracted = { ...base, source: "llm" };
    ex.crossCheck = compareExtractions(text, base, json, model);
    // дополняем только пустые поля и только проверенными значениями
    for (const f of ex.crossCheck.fields) {
      if (f.status !== "llm-only") continue;
      if (f.key === "pack") ex.pack = json.pack;
      else if (f.key === "qty") ex.qty = json.qty;
      else if (f.key === "price") ex.price = json.price;
      else if (f.key === "total") ex.total = json.total;
      else if (f.key === "material") ex.material = json.material;
      else (ex as unknown as Record<string, unknown>)[f.key] = f.llm; // номер счёта, заказ, дата в нормализованном виде
    }
    if (ex.qty !== null && !ex.unit && typeof json.unit === "string") ex.unit = json.unit;
    if (ex.price !== null && !ex.pricePer && (json.pricePer === "unit" || json.pricePer === "pack")) ex.pricePer = json.pricePer;
    // подсветка в тексте для чисел, которые дополнила модель (как у правил)
    ex.spans = { ...base.spans };
    const taken = Object.values(ex.spans).filter(Boolean) as { start: number; end: number }[];
    for (const f of ex.crossCheck.fields) {
      if (f.status !== "llm-only" || !(f.key === "price" || f.key === "total" || f.key === "qty")) continue;
      const val = f.key === "price" ? ex.price : f.key === "total" ? ex.total : ex.qty;
      for (const m of text.matchAll(/\d[\d   ]*(?:[.,]\d+)?/g)) {
        const raw = m[0].trimEnd();
        const n = Number(raw.replace(/[   ]/g, "").replace(",", "."));
        const start = m.index ?? 0;
        if (n === val && !taken.some((t) => start < t.end && start + raw.length > t.start)) {
          ex.spans[f.key] = { start, end: start + raw.length };
          taken.push(ex.spans[f.key]!);
          break;
        }
      }
    }
    // правила не увидели счёт (не нашли сумму), а модель достроила проверенные поля: это счёт
    const hasMoney = ex.total !== null || (ex.qty !== null && ex.price !== null);
    if (ex.kind === "letter" && ex.topic !== "buyer-note" && ex.invoiceNo && hasMoney) {
      ex.kind = ex.resend ? "copy" : /исправлен|скорректирован|откорректирован|\bcorrected\b/i.test(text) ? "correction" : "invoice";
      ex.topic = null;
    }
    // Письмо без счёта («По счёту 202: у нас новый банк»): номер в нём это ссылка на полученный счёт.
    // Правила прочитали его как ссылку, ИИ как номер счёта: это одно и то же, а не поле, которое правила пропустили.
    // Остальное, что ИИ дочитал в письме без счёта, на сверку не влияет: возвращаем разбор правил.
    if (ex.kind === "letter") {
      for (const f of ex.crossCheck.fields) {
        if (f.status !== "llm-only") continue;
        if (f.key === "invoiceNo" && base.invoiceRef && f.llm?.replace(/^0+/, "") === base.invoiceRef.replace(/^0+/, "")) {
          f.rules = `${base.invoiceRef} (ссылка)`;
          f.status = "match";
        }
        (ex as unknown as Record<string, unknown>)[f.key] = (base as unknown as Record<string, unknown>)[f.key];
      }
      ex.unit = base.unit;
      ex.pricePer = base.pricePer;
      ex.spans = { ...base.spans };
      ex.crossCheck.compared = ex.crossCheck.fields.filter((f) => f.status === "match" || f.status === "diff").length;
      ex.crossCheck.matched = ex.crossCheck.fields.filter((f) => f.status === "match").length;
    }
    ex.missing = base.missing.filter((m) => ex[m as keyof Extracted] === null);
    const cc = ex.crossCheck;
    return { ex, note: `Разборы совпали в ${cc.matched} из ${cc.compared} полей` };
  } catch (e) {
    const ex: Extracted = { ...base, crossCheck: { model, fields: [], matched: 0, compared: 0, error: (e as Error).message } };
    return { ex, note: `ИИ недоступен (${(e as Error).message}). Использованы правила` };
  }
}

const LABELS: Record<CrossField["key"], string> = {
  invoiceNo: "Номер счёта",
  orderNo: "Заказ",
  orderDateRef: "Дата заказа",
  material: "Материал",
  qty: "Количество",
  pack: "Фасовка",
  price: "Цена",
  total: "Итог",
};
const CRITICAL = new Set<CrossField["key"]>(["orderNo", "qty", "pack", "price", "total"]);

/** Сравнение по полям. Числа LLM, которых нет в тексте письма, отклоняются. */
export function compareExtractions(text: string, base: Extracted, llm: Record<string, any>, model: string): CrossCheck {
  const textNums = (text.match(/\d[\d\u00a0\u202f ]*(?:[.,]\d+)?/g) ?? []).map((x) => Number(x.replace(/[\u00a0\u202f ]/g, "").replace(",", ".")));
  const inText = (n: unknown) => typeof n === "number" && textNums.some((t) => Math.abs(t - n) < 1e-9);
  const fmt = (n: number | null | undefined) => (n === null || n === undefined ? null : n.toLocaleString("ru-RU", { maximumFractionDigits: 2 }));
  const normOrder = (o: unknown) => (typeof o === "string" && /\d/.test(o) ? "ЗП-" + (o.match(/\d+/)![0]).padStart(2, "0") : null);
  const normStr = (s: unknown) => (typeof s === "string" && s.trim() ? s.trim().toLowerCase().replace(/ё/g, "е").replace(/[«»"]/g, "") : null);
  const fields: CrossField[] = [];
  const push = (key: CrossField["key"], r: string | null, l: string | null, same: boolean, lValid = true) => {
    let status: CrossField["status"];
    if (r === null && l === null) status = "both-empty";
    else if (l !== null && !lValid) status = "llm-rejected";
    else if (r !== null && l === null) status = "rules-only";
    else if (r === null) status = "llm-only";
    else status = same ? "match" : "diff";
    fields.push({ key, label: LABELS[key], rules: r, llm: l, status, critical: CRITICAL.has(key) });
  };

  const li = typeof llm.invoiceNo === "string" ? llm.invoiceNo.trim() : llm.invoiceNo != null ? String(llm.invoiceNo) : null;
  push("invoiceNo", base.invoiceNo, li, !!li && !!base.invoiceNo && li.replace(/^0+/, "") === base.invoiceNo.replace(/^0+/, ""), !li || text.includes(li));
  push("orderNo", base.orderNo, normOrder(llm.orderNo), normOrder(llm.orderNo) === base.orderNo);
  // дату заказа принимаем, только если в письме она стоит рядом со словом «заказ» (а не дата счёта)
  const ld = normStr(llm.orderDateRef);
  const ldShort = ld?.match(/\d{1,2}\.\d{1,2}/)?.[0] ?? null;
  const ldValid = !ldShort || new RegExp(String.raw`заказ[а-яё]*[^.\n]{0,20}от\s+${ldShort.replace(".", String.raw`\.`)}`, "i").test(text);
  push("orderDateRef", base.orderDateRef, ld, ld === base.orderDateRef, ldValid);
  const lm = normStr(llm.material), rm = normStr(base.material);
  push("material", base.material, llm.material ?? null, !!lm && !!rm && (lm.includes(rm) || rm.includes(lm) || lm.split(/\s+/)[0].slice(0, 5) === rm.split(/\s+/)[0].slice(0, 5)));
  // количество: у правил при фасовке qty = число упаковок; модель могла дать то же
  const lq = typeof llm.qty === "number" ? llm.qty : null;
  const rq = base.qty;
  push("qty", fmt(rq), fmt(lq), lq !== null && rq !== null && (lq === rq || (base.pack ? lq === base.pack.count * base.pack.perPack : false)), lq === null || inText(lq));
  const lp = llm.pack && typeof llm.pack === "object" ? llm.pack : null;
  const packStr = (p: { count: number; perPack: number; innerUnit?: string } | null) => (p ? `${fmt(p.count)} × ${fmt(p.perPack)} ${p.innerUnit ?? ""}`.trim() : null);
  push("pack", packStr(base.pack), packStr(lp), !!lp && !!base.pack && lp.count === base.pack.count && lp.perPack === base.pack.perPack, !lp || (inText(lp.count) && inText(lp.perPack)));
  const lpr = typeof llm.price === "number" ? llm.price : null;
  push("price", fmt(base.price), fmt(lpr), lpr !== null && base.price !== null && Math.abs(lpr - base.price) < 1e-9, lpr === null || inText(lpr));
  const lt = typeof llm.total === "number" ? llm.total : null;
  push("total", fmt(base.total), fmt(lt), lt !== null && base.total !== null && Math.abs(lt - base.total) < 1e-9, lt === null || inText(lt));

  const compared = fields.filter((f) => f.status === "match" || f.status === "diff").length;
  const matched = fields.filter((f) => f.status === "match").length;
  return { model, fields: fields.filter((f) => f.status !== "both-empty"), matched, compared };
}

/**
 * «Очеловечить» черновик. ИИ пишет только вступление и концовку: без чисел и без пересказа пунктов.
 * Приветствие, пункты с фактами, суммы, просьба и подпись остаются из шаблона кода.
 * Ответ с цифрами или с «опасными» утверждениями (оплачено, долг, штраф…) отклоняется.
 */
// при «стоп» модель не должна подталкивать к оплате
const STOP_RISKY = /оплат|платеж|платёж|своевременн|ускор/i;
// письмо от первого лица: «мы обращаемся», «просим» выбиваются из шаблона
const WE = /(?<![а-яё])(мы|нас|нам|наш[а-яё]*)(?![а-яё])|(?<![а-яё])(просим|обращаемся|благодарим|ждём|ждем)(?![а-яё])/i;
// письмо подписано бухгалтерией, род автора неизвестен
const GENDER = /(?<![а-яё])(признател[а-яё]*|благодар(ен|на)|рад|рада|обязан|обязана)(?![а-яё])/i;
const RISKY = /оплачен|задолжен|(?<![а-яё])долг(?![а-яё]*(?:осроч|о\s))|штраф|(?<![а-яё])пени(?![а-яё])|судебн|претензи|расторг|гарантир|обещаем/i;

export async function polishDraft(d: Draft, verdict?: Verdict): Promise<{ body: string; note: string }> {
  try {
    const lines = d.body.split("\n");
    const issues = lines.filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ""));
    const ask = lines.find((l) => l.startsWith("Прошу:")) ?? "";
    // модели даём смысл без чисел: факты и суммы вставляет код
    const strip = (x: string) => x.replace(/[А-ЯA-Z]{1,2}-\d+:?|\d[\d\s .,/×]*/g, "…").replace(/(…\s*)+/g, "… ").replace(/\s+/g, " ").trim();
    const stop = verdict === "stop";
    const raw = await chat(
      stop ? "polish-stop" : "polish",
      `Адресат: ${d.to.name} (${d.to.role === "supplier" ? "поставщик" : "сотрудник компании"}). Тема: ${strip(d.subject)}. Причина: ${d.to.reason.replace(/\(П-\d\)/g, "")}.\n` +
        `Что не сходится:\n${issues.map((x) => "- " + strip(x)).join("\n")}\n${strip(ask)}`,
    );
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { intro?: string; outro?: string };
    // приветствие и «С уважением» уже есть в шаблоне: срезаем, если модель всё же их написала
    // длинное тире в интерфейсе не используем (docs/decisions.md): если модель всё же поставила, заменяем запятой
    const noDash = (x: string) => x.replace(/\s*—\s*/g, ", ");
    const intro = noDash(j.intro ?? "").replace(/^(добрый\s+(день|вечер|утро)|здравствуйте)[^.!]*[.!]\s*/i, "").trim();
    const outro = noDash(j.outro ?? "").replace(/\s*с\s+уважением[,.!]?\s*$/i, "").trim();
    if (!intro || !outro) return { body: d.body, note: "ИИ вернул неполный ответ, оставлен шаблон" };
    const all = `${intro} ${outro}`;
    if (/\d/.test(all)) return { body: d.body, note: "ИИ добавил числа, оставлен шаблон" };
    if (RISKY.test(all)) return { body: d.body, note: `ИИ добавил непроверенное утверждение («${all.match(RISKY)![0]}…»), оставлен шаблон` };
    if (stop && STOP_RISKY.test(all)) return { body: d.body, note: `ИИ написал про оплату («${all.match(STOP_RISKY)![0]}…»), а платёж остановлен; оставлен шаблон` };
    if (WE.test(all)) return { body: d.body, note: "ИИ написал от лица «мы», а письмо от первого лица; оставлен шаблон" };
    if (GENDER.test(all)) return { body: d.body, note: `ИИ написал слово с родом («${all.match(GENDER)![0]}»), оставлен шаблон` };
    const thanks = lines.lastIndexOf("Спасибо!");
    const head = lines[0];
    const middle = lines.slice(2, thanks > 0 ? thanks : lines.length).join("\n").trimEnd();
    const sign = thanks > 0 ? lines.slice(thanks + 1).join("\n") : "";
    const body = [head, "", intro, "", middle, "", outro, sign].join("\n");
    return { body, note: "ИИ написал вступление и концовку; пункты, суммы и просьба из сверки без изменений" };
  } catch (e) {
    return { body: d.body, note: `ИИ недоступен, оставлен шаблон (${(e as Error).message})` };
  }
}
