// Сравнение двух независимых разборов: правила и LLM. Ответы модели здесь подставлены вручную.
import { describe, expect, it } from "vitest";
import data from "../data/case.json";
import { extractByRules } from "@/core/extract";
import { reconcileAll } from "@/core/reconcile";
import type { CaseData, Extracted } from "@/core/types";
import { compareExtractions } from "./provider";

const D = data as CaseData;
const v02 = D.letters.find((l) => l.id === "В-02")!;

function withLlm(llm: Record<string, unknown>): Extracted {
  const base = extractByRules(v02.text, v02.sender);
  return { ...base, source: "llm", crossCheck: compareExtractions(v02.text, base, llm, "GigaChat-2-Max") };
}

describe("сверка разборов", () => {
  it("модель прочитала так же: все поля совпали, вердикт прежний", () => {
    const ex = withLlm({ invoiceNo: "202", orderNo: "ЗП-06", material: "пакет 300 г", qty: 5000, unit: "шт", price: 3, total: 15000 });
    expect(ex.crossCheck!.matched).toBe(ex.crossCheck!.compared);
    const r = reconcileAll(D, D.letters, (t, s) => (t === v02.text ? ex : extractByRules(t, s))).find((x) => x.id === "В-02")!;
    expect(r.verdict).toBe("pay");
  });

  it("расхождение в итоге: поле помечено, счёт уходит в «вопрос»", () => {
    const ex = withLlm({ invoiceNo: "202", orderNo: "ЗП-06", qty: 5000, price: 3, total: 1500 });
    expect(ex.crossCheck!.fields.find((f) => f.key === "total")!.status).toBe("llm-rejected"); // 1500 нет в тексте
    const ex2 = withLlm({ invoiceNo: "202", orderNo: "ЗП-06", qty: 300, price: 3, total: 15000 }); // 300 есть в тексте («пакет 300 г»)
    expect(ex2.crossCheck!.fields.find((f) => f.key === "qty")!.status).toBe("diff");
    const r = reconcileAll(D, D.letters, (t, s) => (t === v02.text ? ex2 : extractByRules(t, s))).find((x) => x.id === "В-02")!;
    expect(r.verdict).toBe("ask");
    expect(r.findings.some((f) => f.rule === "Разбор" && f.level === "ask")).toBe(true);
    expect(r.due).toBe(15000); // сумму по-прежнему считает код по разбору правил
  });
});

it("дата счёта не принимается за дату заказа", () => {
  const text = "Счёт на оплату № 53 от 15.11.2026\nОснование: заказ ЗП-08\nКол-во: 100 рул";
  const base = extractByRules(text, "«Лентапром», schet@lentaprom.example");
  const cc = compareExtractions(text, base, { orderDateRef: "15.11" }, "ИИ");
  expect(cc.fields.find((f) => f.key === "orderDateRef")!.status).toBe("llm-rejected");
  const text2 = "Счёт 51 за плёнку по заказу от 05.11: 5 мешков";
  const cc2 = compareExtractions(text2, extractByRules(text2, ""), { orderDateRef: "05.11" }, "ИИ");
  expect(cc2.fields.find((f) => f.key === "orderDateRef")!.status).toBe("match");
});

describe("письмо без счёта: номер это ссылка", () => {
  it("«По счёту 202» у правил и «202» у ИИ совпадают, подсказки нет", async () => {
    const { vi } = await import("vitest");
    const { extractWithLlm } = await import("./provider");
    const text = "По счёту 202: просим перечислить оплату на новый расчётный счёт, у нас сменился банк. Р/с 40702810900000000777.";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ content: JSON.stringify({ invoiceNo: "202" }) }), { status: 200 }));
    const { ex } = await extractWithLlm(text, "«Пакетная линия», invoice@paketline.example");
    vi.unstubAllGlobals();
    expect(ex.kind).toBe("letter");
    expect(ex.invoiceNo).toBeNull();
    const f = ex.crossCheck!.fields.find((x) => x.key === "invoiceNo")!;
    expect(f.status).toBe("match");
    expect(f.rules).toBe("202 (ссылка)");
  });
});

describe("номер заказа от ИИ: число после «П», а не первое число", () => {
  it("разные записи дают один номер", async () => {
    const { normOrderNo } = await import("./provider");
    expect(normOrderNo("3П-06")).toBe("ЗП-06"); // цифра 3 вместо буквы З: раньше получалось ЗП-03
    expect(normOrderNo("ЗП-06")).toBe("ЗП-06");
    expect(normOrderNo("ЗП 6")).toBe("ЗП-06");
    expect(normOrderNo("ЗП-О6")).toBe("ЗП-06"); // буква О вместо нуля
    expect(normOrderNo("ZP-08")).toBe("ЗП-08");
    expect(normOrderNo("по заказу ЗП-12 от 05.11")).toBe("ЗП-12");
    expect(normOrderNo("06")).toBe("ЗП-06");
    expect(normOrderNo("от 05.11")).toBeNull();
    expect(normOrderNo(null)).toBeNull();
  });

  it("письмо с «3П-06»: правила и ИИ совпадают, ложного расхождения нет", async () => {
    const { vi } = await import("vitest");
    const { extractWithLlm } = await import("./provider");
    const text = "Cчет номер 0202 по 3П-06 пакет 300г 5000шт по 3 руб итого 15000 руб";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ content: JSON.stringify({ invoiceNo: "0202", orderNo: "3П-06", qty: 5000, price: 3, total: 15000 }) }), { status: 200 }));
    const { ex } = await extractWithLlm(text, "«Пакетная линия», invoice@paketline.example");
    vi.unstubAllGlobals();
    const f = ex.crossCheck!.fields.find((x) => x.key === "orderNo")!;
    expect(f.rules).toBe("ЗП-06");
    expect(f.llm).toBe("ЗП-06");
    expect(f.status).toBe("match");
  });
});
