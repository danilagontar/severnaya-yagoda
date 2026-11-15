// Типы данных кейса и результата сверки.

export interface Letter {
  id: string;
  received: string; // "ДД.ММ ЧЧ:ММ"
  sender: string;
  text: string;
}

export interface Order {
  id: string;
  date: string; // ДД.ММ.ГГГГ
  supplier: string;
  buyer: string;
  material: string;
  unit: string; // единица заказа: шт | кг | рул
  ordered: number;
  accepted: number;
  lastAcceptance: string | null;
  price: number;
  approvals: string[];
}

export interface Approval {
  id: string;
  date: string;
  order: string;
  text: string;
  status: string; // «Подписано» | «На подписании»
  signer: string | null;
}

export interface Rule {
  id: string;
  topic: string;
  text: string;
}

export interface CaseData {
  meta: { source: string; snapshot: string; note: string };
  letters: Letter[];
  orders: Order[];
  approvals: Approval[];
  rules: Rule[];
}

// ---------- Извлечённые из письма поля ----------

export type DocKind = "invoice" | "correction" | "copy" | "letter";
export type LetterTopic = "requisites" | "delivery-promise" | "buyer-note" | "other";

export interface Span {
  start: number;
  end: number;
}

export type FieldKey =
  | "invoiceNo"
  | "invoiceRef"
  | "orderNo"
  | "orderDateRef"
  | "material"
  | "qty"
  | "price"
  | "total"
  | "requisites"
  | "resend"
  | "approvalClaim"
  | "promise";

export interface Packaging {
  count: number; // сколько упаковок
  packUnit: string; // мешок | рулон | пачка | коробка
  perPack: number; // сколько единиц в упаковке
  innerUnit: string; // шт | кг
}

/** Сравнение двух независимых разборов письма: правила и LLM. */
// confirmed: значение от ИИ (или выбор между разборами) подтвердил или исправил бухгалтер
export type CrossStatus = "match" | "diff" | "llm-only" | "rules-only" | "llm-rejected" | "both-empty" | "confirmed";
export interface CrossField {
  key: "invoiceNo" | "orderNo" | "orderDateRef" | "material" | "qty" | "pack" | "price" | "total";
  label: string;
  rules: string | null;
  llm: string | null;
  status: CrossStatus;
  critical: boolean; // влияет на сумму или привязку
  confirmed?: { value: string; source: FieldSource; was: CrossStatus }; // решение бухгалтера по полю
}
/** Откуда взято подтверждённое значение: у ИИ, у правил или бухгалтер ввёл своё. */
export type FieldSource = "ai" | "rules" | "edited";
export interface CrossCheck {
  model: string;
  fields: CrossField[];
  matched: number;
  compared: number;
  error?: string;
}

export interface Extracted {
  source: "rules" | "llm";
  crossCheck?: CrossCheck;
  senderName: string | null;
  senderEmail: string | null;
  senderDomain: string | null;
  kind: DocKind;
  topic: LetterTopic | null;
  invoiceNo: string | null;
  invoiceRef: string | null; // «по счёту N» в письмах
  orderNo: string | null;
  orderDateRef: string | null; // «заказ от ДД.ММ»
  material: string | null;
  qty: number | null; // в единицах счёта
  unit: string | null; // нормализованная единица счёта
  pack: Packaging | null;
  price: number | null;
  pricePer: "unit" | "pack" | null;
  total: number | null;
  batch: string | null;
  requisitesChange: boolean;
  resend: boolean;
  approvalClaim: string | null; // «по допсоглашению от 12.11», «по новому прайсу»…
  approvalClaimDate: string | null; // ДД.ММ
  promise: string | null; // «привезём до 20.11»
  asksPaymentDate: boolean;
  otherInvoices?: string[]; // ещё номера счетов в этом же письме (разобран только первый)
  forwardedBy?: string | null; // письмо переслано (закупщиком): кто переслал
  fromQuote?: boolean; // счёт взят из цитаты в ответе поставщика
  spans: Partial<Record<FieldKey, Span>>;
  missing: FieldKey[]; // что ожидалось для счёта, но не найдено
}

// ---------- Результат сверки ----------

export type Verdict = "pay" | "ask" | "return" | "duplicate" | "stop" | "letter";

export type Level = "stop" | "return" | "ask" | "info" | "ok";

export interface Finding {
  rule: string; // П-1 … П-9
  level: Level;
  text: string;
  short?: string; // тема в несколько слов для заголовка, когда тем у счёта несколько
  source?: string; // ЗП-04, СГ-05, «приёмка», В-25…
  field?: CrossField["key"]; // поле разбора, которое ждёт подтверждения бухгалтера
}

export type Role = "buyer" | "supplier" | "warehouse" | "treasurer" | "cfo" | "procurement";

export interface Addressee {
  role: Role;
  name: string;
  email?: string;
  reason: string;
}

export type CellStatus = "ok" | "bad" | "warn" | "info" | "none";

export interface CompareRow {
  key: "supplier" | "material" | "qty" | "price" | "total";
  label: string;
  order: string | null;
  approval: string | null;
  acceptance: string | null;
  invoice: string | null;
  status: CellStatus;
  note?: string;
}

export type PreventedCategory = "duplicate" | "fraud" | "price" | "arithmetic";

export interface Result {
  id: string;
  received: string;
  sender: string;
  text: string;
  ex: Extracted;
  supplier: string | null; // распознанный поставщик (как в заказах) или имя отправителя
  supplierStatus: "known" | "lookalike" | "unknown" | "internal";
  orderId: string | null;
  binding: "number" | "attributes" | "probable" | "none";
  invoiced: number | null; // сумма по счёту
  due: number | null; // сумма, которая должна быть по сверке
  payNow: number; // сумма в реестр сейчас
  verdict: Verdict;
  headline: string; // одна фраза причины
  brief: string; // причина в несколько слов для строки очереди
  findings: Finding[];
  addressees: Addressee[];
  related: string[];
  duplicateOf?: string;
  replacedBy?: string;
  prevented: { category: PreventedCategory; amount: number }[];
  deferred: number; // отложено до приёмки / решения (не экономия)
  conversion: string | null; // строка пересчёта фасовки
  compare: CompareRow[];
  orderSummary: string | null; // «по заказу выставлено X из Y»
  isNew: boolean;
  aiPending: CrossField["key"][]; // поля, которые прочитал только ИИ (или разборы разошлись), а бухгалтер ещё не подтвердил
}
