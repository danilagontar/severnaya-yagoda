// Подсказки ИИ: поле, которое прочитал только ИИ, не даёт оплатить, пока его не подтвердит бухгалтер.
import { afterEach, describe, expect, it, vi } from "vitest";
import data from "../data/case.json";
import { extractWithLlm } from "../llm/provider";
import { computeState, makeEvent, type AppEvent } from "./events";
import { extractByRules } from "./extract";
import type { CaseData, Extracted } from "./types";

const D = data as CaseData;
const SENDER = "«Лентапром», schet@lentaprom.example";
// «цена за рулон составляет 95 рублей»: правила цену не находят, число в письме есть
const TEXT = "Исправленный счёт 52 по ЗП-08: лента клейкая 48 мм × 66 м, 240 рул., цена за рулон составляет 95 рублей. Итого 22 800 руб.";

async function llmEx(answer: Record<string, unknown>): Promise<Extracted> {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ content: JSON.stringify(answer) }), { status: 200 }));
  return (await extractWithLlm(TEXT, SENDER)).ex;
}
afterEach(() => vi.unstubAllGlobals());

function run(ex: Extracted, extra: AppEvent[] = []) {
  const letter = makeEvent({ type: "letter", letter: { id: "Н-01", received: "16.11 12:30", sender: SENDER, text: TEXT } });
  const s = computeState(D, [letter, ...extra], (t, snd) => (t === TEXT ? ex : extractByRules(t, snd)));
  return s.results.find((r) => r.id === "Н-01")!;
}
const confirm = (field: "price" | "qty", value: string, source: "ai" | "rules" | "edited" | null) =>
  makeEvent({ type: "field-confirmed", doc: "Н-01", field, value, source });

describe("подсказки ИИ", () => {
  it("правила не нашли цену", () => {
    expect(extractByRules(TEXT, SENDER).price).toBeNull();
  });

  it("цена только от ИИ: вопрос, в реестр не идёт", async () => {
    const r = run(await llmEx({ invoiceNo: "52", orderNo: "ЗП-08", qty: 240, price: 95, total: 22800 }));
    expect(r.aiPending).toEqual(["price"]);
    expect(r.verdict).toBe("ask");
    expect(r.payNow).toBe(0);
  });

  it("бухгалтер подтвердил значение ИИ: оплатить", async () => {
    const r = run(await llmEx({ invoiceNo: "52", orderNo: "ЗП-08", qty: 240, price: 95, total: 22800 }), [confirm("price", "95", "ai")]);
    expect(r.aiPending).toEqual([]);
    expect(r.verdict).toBe("pay");
    expect(r.payNow).toBe(22800);
    expect(r.ex.crossCheck!.fields.find((f) => f.key === "price")!.status).toBe("confirmed");
  });

  it("бухгалтер исправил цену на 90: итог не сходится, вернуть", async () => {
    const r = run(await llmEx({ price: 95 }), [confirm("price", "90", "edited")]);
    expect(r.ex.price).toBe(90);
    expect(r.verdict).toBe("return");
  });

  it("ошибка в итоге по неподтверждённому числу ИИ: вопрос, а не возврат", async () => {
    // ИИ взял 240 за цену (число есть в письме): по такой цене итог не сходится
    const r = run(await llmEx({ price: 240 }));
    expect(r.verdict).toBe("ask");
  });

  it("подтверждение снято: снова вопрос", async () => {
    const r = run(await llmEx({ price: 95 }), [confirm("price", "95", "ai"), confirm("price", "", null)]);
    expect(r.verdict).toBe("ask");
  });

  it("разборы разошлись: бухгалтер выбирает значение правил", async () => {
    const r0 = run(await llmEx({ price: 95, qty: 22800 }));
    expect(r0.aiPending).toContain("qty");
    const r = run(await llmEx({ price: 95, qty: 22800 }), [confirm("price", "95", "ai"), confirm("qty", "", "rules")]);
    expect(r.ex.qty).toBe(240);
    expect(r.verdict).toBe("pay");
  });
});

describe("подтверждения и номера писем", () => {
  it("подтверждение до прихода письма с тем же номером не действует", async () => {
    const ex = await llmEx({ price: 95 });
    const old = makeEvent({ type: "field-confirmed", doc: "Н-01", field: "price", value: "90", source: "edited" });
    const letter = makeEvent({ type: "letter", letter: { id: "Н-01", received: "16.11 12:30", sender: SENDER, text: TEXT } });
    const s = computeState(D, [old, letter], (t, snd) => (t === TEXT ? ex : extractByRules(t, snd)));
    const r = s.results.find((x) => x.id === "Н-01")!;
    expect(r.ex.price).toBe(95);
    expect(r.aiPending).toEqual(["price"]);
  });
});
