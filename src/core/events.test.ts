// Журнал событий, решения бухгалтера и реестр.
import { describe, expect, it } from "vitest";
import data from "../data/case.json";
import { reconcileAll, summarize } from "./reconcile";
import { askOptions, computeState, makeEvent, validateDecision, waitingDays, type AppEvent, type Decision } from "./events";
import type { CaseData } from "./types";

const D = data as CaseData;
const letter = (id: string, sender: string, text: string): AppEvent => makeEvent({ type: "letter", letter: { id, received: "16.11 12:30", sender, text } });
const decide = (doc: string, decision: Decision): AppEvent => makeEvent({ type: "decision", doc, decision });
const st = (events: AppEvent[]) => {
  const s = computeState(D, events);
  return { ...s, get: (id: string) => s.results.find((r) => r.id === id)!, status: (id: string) => s.statuses.get(id)! };
};

describe("журнал событий: данные", () => {
  it("без событий: та же сверка, что для эталона", () => {
    const s = st([]);
    expect(s.results.map((r) => [r.id, r.verdict, r.payNow])).toEqual(reconcileAll(D).map((r) => [r.id, r.verdict, r.payNow]));
    expect(s.registry.items).toEqual([]);
    expect(s.registry.proposed.total).toBe(summarize(reconcileAll(D)).payNow);
    expect(s.registry.status).toBe("draft");
  });

  it("письмо: то же, что новое письмо в очереди: смена банка задерживает В-02", () => {
    const s = st([letter("Н-01", "«Пакетная линия», invoice@paketline.example", "По счёту 202: просим перечислить оплату на новый расчётный счёт, у нас сменился банк.")]);
    expect(s.get("Н-01").verdict).toBe("stop");
    expect(s.get("Н-01").isNew).toBe(true);
    expect(s.get("В-02").verdict).toBe("ask");
  });

  it("приёмка из 1С:ERP: склад принял ещё 200 коробов по ЗП-01: В-07 на 1 000 шт к оплате, В-23 остаётся лишним", () => {
    expect(st([]).get("В-07").verdict).toBe("ask");
    const s = st([makeEvent({ type: "acceptance", order: "ЗП-01", qty: 200, date: "16.11.2026" })]);
    expect(s.get("В-07").verdict).toBe("pay");
    expect(s.get("В-07").payNow).toBe(40000);
    expect(s.get("В-23").verdict).toBe("ask"); // по заказу на 1 000 шт выставлено 1 200
    expect(D.orders.find((o) => o.id === "ЗП-01")!.accepted).toBe(800); // исходные данные не тронуты
  });

  it("подпись в Directum RX: СГ-05 подписано: В-10 по 2,20 к оплате", () => {
    expect(st([]).get("В-10").verdict).toBe("ask");
    const s = st([makeEvent({ type: "approval-signed", approval: "СГ-05", date: "16.11.2026" })]);
    expect(s.get("В-10").verdict).toBe("pay");
    expect(s.get("В-10").payNow).toBe(13200);
  });
});

describe("решения бухгалтера", () => {
  it("подтверждение «оплатить»: счёт в реестре", () => {
    const s = st([decide("В-02", { kind: "confirm", amount: 15000 })]);
    expect(s.status("В-02").inRegistry).toBe(true);
    expect(s.registry.total).toBe(15000);
    expect(s.registry.unconfirmed.some((r) => r.id === "В-02")).toBe(false);
  });

  it("после письма о смене банка подтверждение снимается, счёт уходит из реестра", () => {
    const s = st([
      decide("В-02", { kind: "confirm", amount: 15000 }),
      letter("Н-01", "«Пакетная линия», invoice@paketline.example", "По счёту 202: просим перечислить оплату на новый расчётный счёт, у нас сменился банк."),
    ]);
    expect(s.status("В-02").valid).toBe(false);
    expect(s.status("В-02").stale).toMatch(/вопрос/);
    expect(s.registry.total).toBe(0);
  });

  it("«ждём ответа»: не решено окончательно и не в реестре", () => {
    const s = st([decide("В-07", { kind: "waiting", who: "Олег Смирнов" })]);
    expect(s.status("В-07").waiting).toBe(true);
    expect(s.status("В-07").resolved).toBe(false);
    expect(s.status("В-07").inRegistry).toBe(false);
  });

  it("оплата по решению бухгалтера: в реестре с причиной", () => {
    const s = st([decide("В-17", { kind: "pay-override", amount: 72000, reason: "Договор предусматривает предоплату 100 %, подтвердил О. Смирнов" })]);
    expect(s.status("В-17").inRegistry).toBe(true);
    expect(s.registry.items[0]).toMatchObject({ amount: 72000, basis: "решение бухгалтера" });
  });

  it("проверки решения: больше счёта нельзя, без причины нельзя, «стоп» вручную не оплачивается", () => {
    const s = st([]);
    expect(validateDecision(s.get("В-17"), { kind: "pay-override", amount: 80000, reason: "x" })).toMatch(/больше суммы счёта/);
    expect(validateDecision(s.get("В-17"), { kind: "pay-override", amount: 72000, reason: " " })).toMatch(/причину/);
    expect(validateDecision(s.get("В-16"), { kind: "pay-override", amount: 40000, reason: "x" })).toMatch(/не подходит/);
    expect(validateDecision(s.get("В-16"), { kind: "escalated" })).toBeNull();
    expect(validateDecision(s.get("В-02"), { kind: "reject", reason: "" })).toMatch(/почему/);
  });

  it("стоп засчитывается, когда передано и закупщику, и ФД (П-2)", () => {
    const who = st([]).get("В-16").addressees.map((x) => x.name);
    expect(who.length).toBeGreaterThanOrEqual(2);
    const half = st([decide("В-16", { kind: "escalated", who: [who[0]] })]);
    expect(half.status("В-16").valid).toBe(false);
    expect(half.status("В-16").stale).toBeNull();
    expect(half.status("В-16").remaining).toEqual(who.slice(1));
    const full = st([decide("В-16", { kind: "escalated", who })]);
    expect(full.status("В-16").resolved).toBe(true);
    expect(full.status("В-16").remaining).toEqual([]);
  });

  it("вопрос нескольким адресатам и старые записи «А, Б» одной строкой", () => {
    expect(st([decide("В-07", { kind: "waiting", who: ["Олег Смирнов", "Начальник склада"] })]).status("В-07").sent).toEqual(["Олег Смирнов", "Начальник склада"]);
    expect(st([decide("В-07", { kind: "waiting", who: "Олег Смирнов, Начальник склада" })]).status("В-07").sent).toEqual(["Олег Смирнов", "Начальник склада"]);
  });

  it("лишние решения убраны: у «вернуть» нет вопроса и ручной оплаты, отказ всегда с причиной", () => {
    const s = st([]);
    const ret = s.results.find((x) => x.verdict === "return")!;
    expect(validateDecision(ret, { kind: "waiting", who: ["x"] })).toMatch(/не подходит/);
    expect(validateDecision(ret, { kind: "pay-override", amount: 1, reason: "x" })).toMatch(/не подходит/);
    expect(validateDecision(ret, { kind: "returned" })).toBeNull();
    expect(validateDecision(ret, { kind: "reject", reason: "" })).toMatch(/почему/);
    expect(validateDecision(s.get("В-16"), { kind: "waiting", who: ["x"] })).toMatch(/не подходит/);
    expect(validateDecision(s.get("В-16"), { kind: "reject", reason: "мошенники" })).toMatch(/не подходит/);
  });

  it("сколько дней ждём ответа", () => {
    const at = "2026-11-16T09:00:00.000Z";
    expect(waitingDays(at, new Date("2026-11-16T18:00:00Z"))).toBe(0);
    expect(waitingDays(at, new Date("2026-11-19T10:00:00Z"))).toBe(3);
    expect(waitingDays(null)).toBe(0);
  });

  it("«вернуть в работу» снимает решение", () => {
    const s = st([decide("В-02", { kind: "confirm", amount: 15000 }), makeEvent({ type: "reopen", doc: "В-02" })]);
    expect(s.status("В-02").decision).toBeNull();
    expect(s.registry.total).toBe(0);
  });
});

describe("реестр: передача и утверждение", () => {
  const confirmed = [decide("В-02", { kind: "confirm", amount: 15000 }), decide("В-08", { kind: "confirm", amount: 55000 })];
  const submit = makeEvent({ type: "registry-submitted", ids: ["В-02", "В-08"], total: 70000 });

  it("передан ФД, затем утверждён", () => {
    expect(st([...confirmed, submit]).registry.status).toBe("submitted");
    const s = st([...confirmed, submit, makeEvent({ type: "registry-approved" })]);
    expect(s.registry.status).toBe("approved");
    expect(s.registry.approvedAt).not.toBeNull();
  });

  it("реестр изменился после передачи: снова черновик", () => {
    const s = st([...confirmed, submit, makeEvent({ type: "registry-approved" }), makeEvent({ type: "reopen", doc: "В-08" })]);
    expect(s.registry.status).toBe("draft");
    expect(s.registry.changedAfterSubmit).toBe(true);
  });
});

import { SCENARIOS } from "../data/scenarios";
import { metrics, metricsDelta, orderTimeline } from "./events";

describe("сценарии для показа", () => {
  const run = (id: string) => st([makeEvent(SCENARIOS.find((s) => s.id === id)!.event)]);
  it("ЗП-01: приёмка 200 коробов: В-07 к оплате на 40 000 ₽", () => {
    expect(run("acc-zp01").get("В-07").verdict).toBe("pay");
  });
  it("ЗП-05: приёмка 80 поддонов: В-17 к оплате на 72 000 ₽", () => {
    const s = run("acc-zp05");
    expect(s.get("В-17").verdict).toBe("pay");
    expect(s.get("В-17").payNow).toBe(72000);
  });
  it("СГ-05 подписано: В-10 к оплате по 2,20", () => {
    expect(run("sign-sg05").get("В-10").verdict).toBe("pay");
  });
  it("метки разницы: подтверждение В-02: +15 000 в реестре, разобрано +1", () => {
    const a = metrics(st([]));
    const b = metrics(st([decide("В-02", { kind: "confirm", amount: 15000 })]));
    expect(metricsDelta(a, b)).toEqual({ registry: 15000, decided: 1 });
  });
  it("метки разницы: приёмка по ЗП-01: меньше отложено и меньше требует решения", () => {
    const d = metricsDelta(metrics(st([])), metrics(run("acc-zp01")));
    expect(d.deferred).toBeLessThan(0);
    expect(d.need).toBe(-1);
    expect(d.proposed).toBeGreaterThan(0); // В-07 стал «оплатить»: растёт крупная цифра плитки «К оплате»
  });
});

describe("хронология заказа", () => {
  it("ЗП-01: заказ, согласование, приёмка, счета и письма по дате, событие журнала в конце", () => {
    const ev = [makeEvent(SCENARIOS[0].event)];
    const s = st(ev);
    const t = orderTimeline(D, ev, s.results, "ЗП-01");
    expect(t[0].text).toMatch(/^Заказ ЗП-01/);
    expect(t.map((x) => x.docId).filter(Boolean)).toEqual(["В-07", "В-16", "В-18", "В-23"]);
    expect(t.find((x) => x.key === "СГ-03")?.source).toBe("Directum RX");
    expect(t.at(-1)).toMatchObject({ simulated: true, source: "1С:ERP", text: "Приёмка +200 шт" });
  });
});

describe("оплата казначеем и архив", () => {
  const confirmed = [decide("В-02", { kind: "confirm", amount: 15000 }), decide("В-08", { kind: "confirm", amount: 55000 })];
  const cycle = [
    ...confirmed,
    makeEvent({ type: "registry-submitted", ids: ["В-02", "В-08"], total: 70000 }),
    makeEvent({ type: "registry-approved" }),
    makeEvent({ type: "registry-paid", items: [{ id: "В-02", amount: 15000 }, { id: "В-08", amount: 55000 }], total: 70000 }),
  ];

  it("после оплаты счета в архиве, реестр пуст и собирается заново", () => {
    const s = st(cycle);
    expect(s.status("В-02").paid?.amount).toBe(15000);
    expect(s.status("В-02").archived).toBe(true);
    expect(s.registry.items).toEqual([]);
    expect(s.registry.status).toBe("draft");
    expect(s.registry.changedAfterSubmit).toBe(false);
    expect(s.registry.lastPaid).toMatchObject({ total: 70000, count: 2 });
    // «К оплате» больше не включает оплаченное
    expect(s.registry.proposed.total).toBe(st([]).registry.proposed.total - 70000);
  });

  it("оплаченное не снимается, даже если потом пришло письмо о смене банка", () => {
    const s = st([...cycle, letter("Н-01", "«Пакетная линия», invoice@paketline.example", "По счёту 202: просим перечислить оплату на новый расчётный счёт, у нас сменился банк.")]);
    expect(s.status("В-02").paid).not.toBeNull();
    expect(s.status("В-02").stale).toBeNull();
  });

  it("в архиве дубли и «не платить»; письмо уходит в архив вместе со своим счётом", () => {
    const s = st([decide("В-10", { kind: "reject", reason: "поставщик отозвал счёт" })]);
    expect(s.status("В-14").archived).toBe(true); // копия В-02
    expect(s.status("В-10").archived).toBe(true);
    expect(s.status("В-11").archived).toBe(true); // письмо закупщика к В-10
    expect(st([]).status("В-11").archived).toBe(false);
    expect(s.status("В-07").archived).toBe(false);
  });
});

describe("кнопки по правилам", () => {
  const s = st([]);
  it("П-2 (новые реквизиты): только передать вопрос, ни оплаты, ни отказа", () => {
    expect(askOptions(s.get("В-05"))).toEqual({ override: false, reject: false });
  });
  it("П-5 (условия договора): оплатить по решению можно, отказать нельзя", () => {
    expect(askOptions(s.get("В-07"))).toEqual({ override: true, reject: false });
    expect(askOptions(s.get("В-17"))).toEqual({ override: true, reject: false });
    expect(validateDecision(s.get("В-17"), { kind: "reject", reason: "дорого" })).toMatch(/П-5/);
  });
  it("П-6 (цена без подписи): вручную не оплатить, отказ с причиной можно", () => {
    expect(askOptions(s.get("В-10"))).toEqual({ override: false, reject: true });
    expect(validateDecision(s.get("В-10"), { kind: "pay-override", amount: 13200, reason: "договорились" })).toMatch(/П-5/);
  });
  it("старое решение вне правил снимается", () => {
    const x = st([decide("В-10", { kind: "pay-override", amount: 13200, reason: "договорились" })]);
    expect(x.status("В-10").valid).toBe(false);
    expect(x.status("В-10").stale).toMatch(/по правилам/i);
  });
});

describe("исправленный счёт после оплаты", () => {
  const paidCycle = [
    decide("В-02", { kind: "confirm", amount: 15000 }),
    makeEvent({ type: "registry-submitted", ids: ["В-02"], total: 15000 }),
    makeEvent({ type: "registry-approved" }),
    makeEvent({ type: "registry-paid", items: [{ id: "В-02", amount: 15000 }], total: 15000 }),
  ];
  const fix = (text: string) => letter("Н-01", "«Пакетная линия», invoice@paketline.example", text);

  it("та же сумма: второй раз не платим", () => {
    const s = st([...paidCycle, fix("Исправленный счёт 202 по ЗП-06: пакет для ягод 300 г, 5000 шт. по 3 руб. Итого 15 000 руб.")]);
    expect(s.get("Н-01").verdict).toBe("ask");
    expect(s.get("Н-01").payNow).toBe(0);
    expect(s.get("Н-01").due).toBe(0);
    expect(s.status("В-02").paid).not.toBeNull();
    expect(s.get("В-02").verdict).not.toBe("duplicate");
    expect(s.registry.proposed.total).toBe(st([]).registry.proposed.total - 15000);
    expect(askOptions(s.get("Н-01"))).toEqual({ override: false, reject: true });
  });

  it("исправленный дороже: доплатить можно только разницу", () => {
    const s = st([...paidCycle, fix("Исправленный счёт 202 по ЗП-06: пакет для ягод 300 г, 5000 шт. по 3 руб. Итого 15 000 руб.")]);
    expect(validateDecision(s.get("Н-01"), { kind: "pay-override", amount: 15000, reason: "x" })).toBeTruthy();
  });
});

describe("П-9 склад и П-2 допсоглашение", () => {
  it("поставщик пишет «уже приняты», в ERP приёмки нет: вопрос складу", () => {
    const s = st([letter("Н-01", "«Тверской поддон», buh@tver-poddon.example", "По счёту 88: поддоны уже приняты вашим складом, просим оплатить.")]);
    expect(s.get("В-17").addressees.map((a) => a.role)).toContain("warehouse");
    expect(s.get("Н-01").addressees.map((a) => a.role)).toContain("warehouse");
  });
  it("подписанное допсоглашение о реквизитах: письмо не стоп, счёт не задержан", () => {
    const withSigned = { ...D, approvals: [...D.approvals, { id: "СГ-07", date: "14.11.2026", order: "ЗП-06", text: "Смена банковских реквизитов поставщика: новый расчётный счёт.", status: "Подписано", signer: "С. Пахомов" }] };
    const bank = { id: "Н-01", received: "16.11 12:30", sender: "«Пакетная линия», invoice@paketline.example", text: "По счёту 202: просим перечислить оплату на новый расчётный счёт, у нас сменился банк." };
    const r = reconcileAll(withSigned, [...D.letters, bank]);
    expect(r.find((x) => x.id === "Н-01")!.verdict).toBe("letter");
    expect(r.find((x) => x.id === "В-02")!.verdict).toBe("pay");
    // без допсоглашения: стоп, как раньше
    expect(reconcileAll(D, [...D.letters, bank]).find((x) => x.id === "Н-01")!.verdict).toBe("stop");
  });
});
