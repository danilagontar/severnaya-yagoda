// Ядро сверки против ручной эталонной разметки (data/case04_etalon.md), все 25 документов.
import { describe, expect, it } from "vitest";
import data from "../data/case.json";
import { reconcileAll, summarize } from "./reconcile";
import type { CaseData } from "./types";
import { BUYERS, ETALON } from "./etalon";

const results = reconcileAll(data as CaseData);
const get = (id: string) => results.find((r) => r.id === id)!;

describe("эталон: 25 документов", () => {
  it("обработаны все 25 документов", () => expect(results).toHaveLength(25));

  for (const e of ETALON) {
    it(`${e.id}: ${e.verdict}`, () => {
      const r = get(e.id);
      expect(r.verdict, r.headline).toBe(e.verdict);
      expect(r.orderId).toBe(e.order);
      expect(r.invoiced).toBe(e.invoiced);
      if (e.due !== null) expect(r.due).toBe(e.due);
      expect(r.addressees.map((a) => a.role).sort()).toEqual([...e.to].sort());
      for (const rule of e.rules ?? []) expect(r.findings.map((f) => f.rule)).toContain(rule);
      for (const rel of e.related ?? []) expect(r.related).toContain(rel);
      if (e.binding) expect(r.binding).toBe(e.binding);
      if (BUYERS[e.id]) expect(r.addressees.find((a) => a.role === "buyer")?.name).toBe(BUYERS[e.id]);
      if (e.verdict === "pay") expect(r.payNow).toBe(e.due);
      else expect(r.payNow).toBe(0);
    });
  }

  it("ловушки: одинаковые номера у разных поставщиков: не дубли", () => {
    expect(get("В-04").verdict).toBe("pay"); // 45 у Лентапрома и Плёнки-Ладоги
    expect(get("В-10").verdict).not.toBe("duplicate"); // 117 у Гофроцентра и Этикетки-Норд
  });

  it("дубли и замены ссылаются на исходный документ", () => {
    expect(get("В-14").duplicateOf).toBe("В-02");
    expect(get("В-22").duplicateOf).toBe("В-09");
    expect(get("В-18").duplicateOf).toBe("В-07");
    expect(get("В-03").replacedBy).toBe("В-06");
  });

  it("пересчёт фасовки показан явно", () => {
    const sp = (s: string | null) => (s ?? "").replace(/[  ]/g, " ");
    expect(sp(get("В-06").conversion)).toContain("= 200 кг");
    expect(sp(get("В-06").conversion)).toContain("180 ₽/кг");
    expect(sp(get("В-12").conversion)).toContain("= 10 000 шт");
    expect(sp(get("В-12").conversion)).toContain("1,50 ₽/шт");
  });
});

describe("эталон: итоги", () => {
  const s = summarize(results);
  it("к оплате сразу: 7 счетов на 231 700 ₽", () => {
    expect(s.payNowCount).toBe(7);
    expect(s.payNow).toBe(231700);
  });
  it("предотвращено: дубли 87 500, подмена 40 000, цены 7 300, итог 1 000", () => {
    expect(s.prevented).toEqual({ duplicate: 87500, fraud: 40000, price: 7300, arithmetic: 1000 });
    expect(s.preventedTotal).toBe(135800);
  });
  it("отложено до приёмки/решения: 8 000 + 8 000 + 72 000 + 480", () => expect(s.deferred).toBe(88480));
  it("21 счёт и 4 письма", () => {
    expect(s.invoices).toBe(21);
    expect(s.letters).toBe(4);
  });
  it("сверка пройдена, но платёж задержан из-за реквизитов: 14 000 ₽ (В-05)", () => expect(s.held).toBe(14000));
});
