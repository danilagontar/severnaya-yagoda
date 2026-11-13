// Инструкции для модели живут только на сервере: браузер присылает название задачи и текст,
// поэтому чужой сайт или скрипт не может использовать наш ключ GigaChat для своих запросов.

const EXTRACT = `Ты извлекаешь поля из письма поставщика в бухгалтерию. Ничего не вычисляй и не придумывай.
Верни только JSON без пояснений: {"invoiceNo": строка|null, "orderNo": "ЗП-NN"|null, "orderDateRef": "ДД.ММ"|null,
"material": строка|null, "qty": число|null, "unit": "шт"|"кг"|"рул"|"мешок"|"пачка"|null,
"pack": {"count": число, "packUnit": строка, "perPack": число, "innerUnit": "шт"|"кг"}|null,
"price": число|null, "pricePer": "unit"|"pack"|null, "total": число|null}.
Если поля нет в тексте, ставь null. Числа пиши как в тексте, без пересчёта.`;

const POLISH_BASE =
  "Ты помогаешь бухгалтеру написать деловое письмо по-русски. Приветствие, пронумерованный список фактов, суммы, просьба и подпись уже есть в письме: не пиши и не пересказывай их. " +
  'Напиши две части: "intro" — одно предложение, зачем пишу; "outro" — одно предложение с вежливой просьбой ответить и благодарностью. ' +
  "Пиши от первого лица единственного числа («я», «прошу»), как остальной текст письма, без глаголов прошедшего времени и без слов с мужским или женским родом (не «признателен», «благодарен», «рад» — вместо них «спасибо», «заранее благодарю»). " +
  "Никаких чисел, сумм, дат, номеров. Не добавляй фактов, которых нет в описании: ничего про долги, штрафы, претензии, сроки. ";

const POLISH_STOP =
  "Это подозрение на подмену получателя платежа: платёж остановлен. Не пиши ничего о подготовке, ускорении или своевременности оплаты, не обещай оплату. ";

const JSON_TAIL = 'Верни только JSON: {"intro": "...", "outro": "..."}';

export const TASKS = {
  extract: { system: EXTRACT, purpose: "извлечение полей" },
  polish: { system: POLISH_BASE + JSON_TAIL, purpose: "черновик письма" },
  "polish-stop": { system: POLISH_BASE + POLISH_STOP + JSON_TAIL, purpose: "черновик письма" },
} as const;
export type Task = keyof typeof TASKS;
export const isTask = (t: unknown): t is Task => typeof t === "string" && t in TASKS;

export const MAX_USER_LEN = 8000;

// Простое ограничение частоты: не больше LIMIT запросов к модели с одного адреса за минуту.
const LIMIT = 20;
const hits = new Map<string, number[]>();
export function rateLimited(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > LIMIT;
}

/** Запрос со страницы того же сайта: Origin (если браузер его прислал) должен совпадать с Host. */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // запросы без Origin (curl) всё равно ограничены задачами и частотой
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
