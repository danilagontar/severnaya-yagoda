// Журнал событий поверх данных кейса.
//
// Состояние пилота = исходная выгрузка + события по порядку → сверка (reconcile.ts, не меняется)
// → решения бухгалтера → реестр. Так одинаково устроены: новые письма, симуляция приёмки (1С:ERP)
// и подписания согласований (Directum RX), решения бухгалтера и передача реестра ФД.
// В продукте этот же журнал станет журналом действий в базе.

import { reconcileAll, type Extractor } from "./reconcile";
import type { CaseData, Letter, Result, Verdict } from "./types";

// ---------- события ----------

export type Decision =
  | { kind: "confirm"; amount: number } // оплатить по сверке; amount: сумма на момент подтверждения
  | { kind: "waiting"; who: string } // вопрос отправлен, ждём ответа
  | { kind: "pay-override"; amount: number; reason: string } // оплатить по решению бухгалтера (правилами не решается)
  | { kind: "returned" } // счёт возвращён поставщику на исправление
  | { kind: "reject"; reason: string } // не платить
  | { kind: "escalated" }; // стоп передан ФД и закупщику

export type DecisionKind = Decision["kind"];

type EventBody =
  | { type: "letter"; letter: Letter } // почта
  | { type: "acceptance"; order: string; qty: number; date: string } // 1С:ERP: проведена приёмка
  | { type: "approval-signed"; approval: string; date: string } // Directum RX: согласование подписано
  | { type: "decision"; doc: string; decision: Decision } // бухгалтер
  | { type: "reopen"; doc: string } // бухгалтер: вернуть в работу
  | { type: "registry-submitted"; ids: string[]; total: number } // бухгалтер: реестр передан ФД
  | { type: "registry-approved" }; // ФД: реестр утверждён

export type AppEvent = EventBody & { id: string; at: string /* ISO-время */ };
export type EventType = AppEvent["type"];

export const EVENT_SOURCE: Record<EventType, string> = {
  letter: "почта",
  acceptance: "1С:ERP",
  "approval-signed": "Directum RX",
  decision: "бухгалтер",
  reopen: "бухгалтер",
  "registry-submitted": "бухгалтер",
  "registry-approved": "финансовый директор",
};

let seq = 0;
/** Новое событие с id и временем. */
export function makeEvent(body: EventBody, now: Date = new Date()): AppEvent {
  seq += 1;
  return { ...body, id: `e${now.getTime().toString(36)}${seq.toString(36)}`, at: now.toISOString() } as AppEvent;
}

// ---------- данные с учётом событий ----------

/** Данные кейса после событий из 1С:ERP и Directum RX плюс письма из почты. Исходный объект не меняется. */
export function applyData(base: CaseData, events: AppEvent[]): { data: CaseData; letters: Letter[]; newIds: Set<string> } {
  const orders = base.orders.map((o) => ({ ...o }));
  const approvals = base.approvals.map((a) => ({ ...a }));
  const extra: Letter[] = [];
  for (const e of events) {
    if (e.type === "letter") extra.push(e.letter);
    else if (e.type === "acceptance") {
      const o = orders.find((x) => x.id === e.order);
      if (o) {
        o.accepted += e.qty;
        o.lastAcceptance = e.date;
      }
    } else if (e.type === "approval-signed") {
      const a = approvals.find((x) => x.id === e.approval);
      if (a) {
        a.status = "Подписано";
        a.signer = a.signer ?? "по событию Directum RX";
      }
    }
  }
  return { data: { ...base, orders, approvals }, letters: [...base.letters, ...extra], newIds: new Set(extra.map((l) => l.id)) };
}

// ---------- решения бухгалтера ----------

/** На каких вердиктах решение имеет смысл. Если вердикт сменился (пришло письмо, приёмка, подпись), решение снимается. */
const ALLOWED: Record<DecisionKind, Verdict[]> = {
  confirm: ["pay"],
  waiting: ["ask", "return", "stop"],
  "pay-override": ["ask", "return"], // «стоп» вручную не оплачивается
  returned: ["return", "ask"],
  reject: ["pay", "ask", "return", "stop"],
  escalated: ["stop"],
};

export const DECISION_LABEL: Record<DecisionKind, string> = {
  confirm: "В реестре",
  waiting: "Ждём ответа",
  "pay-override": "В реестре по решению бухгалтера",
  returned: "Возвращено поставщику",
  reject: "Не платить",
  escalated: "Передано ФД и закупщику",
};

export interface DocStatus {
  decision: Decision | null; // последнее решение (даже если снято)
  at: string | null;
  valid: boolean; // решение действует при текущем вердикте и сумме
  stale: string | null; // почему решение снято
  waiting: boolean;
  resolved: boolean; // решено окончательно (не «ждём ответа»)
  inRegistry: boolean;
  amount: number; // сумма в реестре
}

const EPS = 0.005;
const EMPTY: DocStatus = { decision: null, at: null, valid: false, stale: null, waiting: false, resolved: false, inRegistry: false, amount: 0 };

/** Проверка решения перед записью: возвращает текст ошибки или null. */
export function validateDecision(r: Result, d: Decision): string | null {
  if (!ALLOWED[d.kind].includes(r.verdict)) return "Это решение не подходит к текущему вердикту.";
  if (d.kind === "pay-override") {
    if (!(d.amount > 0)) return "Укажите сумму больше нуля.";
    if (r.invoiced !== null && d.amount > r.invoiced + EPS) return `Сумма не может быть больше суммы счёта (${r.invoiced.toLocaleString("ru-RU")} ₽).`;
    if (!d.reason.trim()) return "Укажите причину: на чём основано решение.";
  }
  if (d.kind === "reject" && r.verdict === "pay" && !d.reason.trim()) return "Сверка пройдена. Укажите, почему не платить.";
  return null;
}

/** Статус каждого документа по журналу: какое решение принято и действует ли оно сейчас. */
export function applyDecisions(results: Result[], events: AppEvent[]): Map<string, DocStatus> {
  const last = new Map<string, { decision: Decision; at: string } | null>();
  for (const e of events) {
    if (e.type === "decision") last.set(e.doc, { decision: e.decision, at: e.at });
    else if (e.type === "reopen") last.set(e.doc, null);
  }
  const out = new Map<string, DocStatus>();
  for (const r of results) {
    const l = last.get(r.id);
    if (!l) {
      out.set(r.id, EMPTY);
      continue;
    }
    const d = l.decision;
    let stale: string | null = null;
    if (!ALLOWED[d.kind].includes(r.verdict)) stale = `Вердикт изменился на «${VERDICT_WORD[r.verdict]}», решение снято.`;
    else if (d.kind === "confirm" && Math.abs(r.payNow - d.amount) > EPS)
      stale = `Сумма к оплате изменилась: было ${d.amount.toLocaleString("ru-RU")} ₽, стало ${r.payNow.toLocaleString("ru-RU")} ₽. Подтвердите заново.`;
    else if (d.kind === "pay-override" && r.invoiced !== null && d.amount > r.invoiced + EPS) stale = "Сумма решения больше суммы счёта, решение снято.";
    const valid = !stale;
    const inRegistry = valid && (d.kind === "confirm" || d.kind === "pay-override");
    out.set(r.id, {
      decision: d,
      at: l.at,
      valid,
      stale,
      waiting: valid && d.kind === "waiting",
      resolved: valid && d.kind !== "waiting",
      inRegistry,
      amount: inRegistry ? (d.kind === "confirm" ? r.payNow : d.amount) : 0,
    });
  }
  return out;
}

const VERDICT_WORD: Record<Verdict, string> = { pay: "оплатить", ask: "вопрос", return: "вернуть", duplicate: "дубль", stop: "стоп", letter: "письмо" };

// ---------- реестр ----------

export interface RegistryItem {
  r: Result;
  amount: number;
  basis: "сверка" | "решение бухгалтера";
  reason: string | null;
}

export interface RegistryState {
  items: RegistryItem[];
  total: number;
  proposed: { count: number; total: number }; // предложено сверкой (вердикт «оплатить»)
  unconfirmed: Result[]; // «оплатить», но бухгалтер ещё не подтвердил
  status: "draft" | "submitted" | "approved";
  submittedAt: string | null;
  approvedAt: string | null;
  changedAfterSubmit: boolean; // реестр передавали, но потом он изменился
}

export function registryState(results: Result[], statuses: Map<string, DocStatus>, events: AppEvent[]): RegistryState {
  const items: RegistryItem[] = [];
  for (const r of results) {
    const s = statuses.get(r.id);
    if (!s?.inRegistry || !s.decision) continue;
    items.push({ r, amount: s.amount, basis: s.decision.kind === "confirm" ? "сверка" : "решение бухгалтера", reason: s.decision.kind === "pay-override" ? s.decision.reason : null });
  }
  const total = round2(items.reduce((x, i) => x + i.amount, 0));
  const pay = results.filter((r) => r.verdict === "pay");
  const proposed = { count: pay.length, total: round2(pay.reduce((x, r) => x + r.payNow, 0)) };
  const unconfirmed = pay.filter((r) => !statuses.get(r.id)?.valid);

  // Передача действует, пока реестр тот же: те же документы и та же сумма.
  let submitted: Extract<AppEvent, { type: "registry-submitted" }> | null = null;
  let approvedAt: string | null = null;
  for (const e of events) {
    if (e.type === "registry-submitted") {
      submitted = e;
      approvedAt = null;
    } else if (e.type === "registry-approved" && submitted) approvedAt = e.at;
  }
  const same = !!submitted && Math.abs(submitted.total - total) < EPS && submitted.ids.length === items.length && submitted.ids.every((id) => items.some((i) => i.r.id === id));
  return {
    items,
    total,
    proposed,
    unconfirmed,
    status: same ? (approvedAt ? "approved" : "submitted") : "draft",
    submittedAt: same ? submitted!.at : null,
    approvedAt: same ? approvedAt : null,
    changedAfterSubmit: !!submitted && !same,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------- всё состояние разом ----------

export interface PilotState {
  data: CaseData;
  results: Result[];
  statuses: Map<string, DocStatus>;
  registry: RegistryState;
}

/** Исходные данные + журнал → сверка → решения → реестр. Сверка та же, что для эталона. */
export function computeState(base: CaseData, events: AppEvent[], extractor?: Extractor): PilotState {
  const { data, letters, newIds } = applyData(base, events);
  const results = reconcileAll(data, letters, extractor, newIds);
  const statuses = applyDecisions(results, events);
  return { data, results, statuses, registry: registryState(results, statuses, events) };
}

// ---------- хронология заказа ----------

export interface TimelineItem {
  key: string;
  when: string; // «03.11», «12.11 09:15», «сейчас»
  text: string;
  source: string; // 1С:ERP, Directum RX, почта, бухгалтер
  docId?: string; // ссылка на документ очереди
  verdict?: Verdict;
  simulated?: boolean; // событие из журнала (в продукте придёт из интеграции)
}

const dm = (d: string | null | undefined) => (d ? d.slice(0, 5) : "");
// ключ сортировки «ММДДЧЧММ» из «ДД.ММ[.ГГГГ] [ЧЧ:ММ]»
const sortKey = (d: string) => {
  const m = d.match(/(\d{2})\.(\d{2})(?:\.\d{4})?(?:\s+(\d{2}):(\d{2}))?/);
  return m ? `${m[2]}${m[1]}${m[3] ?? "00"}${m[4] ?? "00"}` : "99999999";
};

/**
 * История заказа: заказ и приёмка (1С:ERP), согласования (Directum RX), счета и письма (почта) по дате,
 * затем события журнала по этому заказу в порядке поступления.
 */
export function orderTimeline(base: CaseData, events: AppEvent[], results: Result[], orderId: string): TimelineItem[] {
  const o = base.orders.find((x) => x.id === orderId);
  if (!o) return [];
  const dated: (TimelineItem & { k: string })[] = [];
  dated.push({ key: "order", k: sortKey(o.date), when: dm(o.date), text: `Заказ ${o.id}: ${o.ordered.toLocaleString("ru-RU")} ${o.unit} по ${o.price.toLocaleString("ru-RU")} ₽`, source: "1С:ERP" });
  for (const a of base.approvals.filter((x) => x.order === orderId))
    dated.push({ key: a.id, k: sortKey(a.date), when: dm(a.date), text: `${a.id} (${a.status.toLowerCase()}): ${a.text}`, source: "Directum RX" });
  if (o.lastAcceptance)
    dated.push({ key: "acc", k: sortKey(o.lastAcceptance) + "9", when: dm(o.lastAcceptance), text: `Принято на складе ${o.accepted.toLocaleString("ru-RU")} ${o.unit}`, source: "1С:ERP" });
  else dated.push({ key: "acc", k: "99999998", when: "", text: `На складе ничего не принято (срез ${base.meta.snapshot})`, source: "1С:ERP" });
  const evLetters = new Set(events.flatMap((e) => (e.type === "letter" ? [e.letter.id] : [])));
  for (const r of results.filter((x) => x.orderId === orderId && !evLetters.has(x.id))) {
    const what = r.ex.kind === "letter" ? `письмо: «${r.text.replace(/\s+/g, " ").slice(0, 70)}${r.text.length > 70 ? "…" : ""}»` : `счёт ${r.ex.invoiceNo ?? "без номера"}${r.ex.qty !== null ? ` на ${r.ex.qty.toLocaleString("ru-RU")} ${r.ex.unit ?? ""}`.trimEnd() : ""}`;
    dated.push({ key: r.id, k: sortKey(r.received), when: r.received, text: `${r.id} ${what}`, source: "почта", docId: r.id, verdict: r.verdict });
  }
  dated.sort((a, b) => a.k.localeCompare(b.k));
  const out: TimelineItem[] = dated.map(({ k: _k, ...x }) => x);

  // события журнала по этому заказу
  for (const e of events) {
    if (e.type === "acceptance" && e.order === orderId)
      out.push({ key: e.id, when: "сейчас", text: `Приёмка +${e.qty.toLocaleString("ru-RU")} ${o.unit}`, source: "1С:ERP", simulated: true });
    else if (e.type === "approval-signed" && base.approvals.some((a) => a.id === e.approval && a.order === orderId))
      out.push({ key: e.id, when: "сейчас", text: `${e.approval} подписано`, source: "Directum RX", simulated: true });
    else if (e.type === "letter") {
      const r = results.find((x) => x.id === e.letter.id);
      if (r?.orderId === orderId)
        out.push({ key: e.id, when: e.letter.received, text: `${r.id} ${r.ex.kind === "letter" ? "письмо" : `счёт ${r.ex.invoiceNo ?? "без номера"}`}`, source: "почта", docId: r.id, verdict: r.verdict, simulated: true });
    }
  }
  return out;
}

// ---------- показатели сводки (для плиток и меток разницы) ----------

export interface Metrics {
  registry: number; // в реестре
  prevented: number; // не платить
  deferred: number; // отложено
  need: number; // требует решения
  decided: number; // разобрано
}

export function metrics(s: PilotState): Metrics {
  let prevented = 0,
    deferred = 0,
    need = 0,
    decided = 0;
  for (const r of s.results) {
    for (const p of r.prevented) prevented += p.amount;
    deferred += r.deferred;
    const st = s.statuses.get(r.id);
    if ((r.verdict === "stop" || r.verdict === "return" || r.verdict === "ask") && !st?.valid) need++;
    if (r.verdict !== "duplicate" && r.verdict !== "letter" && st?.resolved) decided++;
  }
  return { registry: s.registry.total, prevented: round2(prevented), deferred: round2(deferred), need, decided };
}

/** Разница показателей: только изменившиеся. */
export function metricsDelta(a: Metrics, b: Metrics): Partial<Metrics> {
  const out: Partial<Metrics> = {};
  for (const k of Object.keys(a) as (keyof Metrics)[]) if (Math.abs(b[k] - a[k]) > EPS) out[k] = round2(b[k] - a[k]);
  return out;
}

/** Короткое описание события для баннера и журнала. */
export function describeEvent(e: AppEvent): string {
  switch (e.type) {
    case "letter":
      return `письмо ${e.letter.id}`;
    case "acceptance":
      return `приёмка +${e.qty.toLocaleString("ru-RU")} по ${e.order}`;
    case "approval-signed":
      return `${e.approval} подписано`;
    case "decision":
      return `${e.doc}: ${DECISION_LABEL[e.decision.kind].toLowerCase()}`;
    case "reopen":
      return `${e.doc}: возвращён в работу`;
    case "registry-submitted":
      return "реестр передан ФД";
    case "registry-approved":
      return "реестр утверждён ФД";
  }
}
