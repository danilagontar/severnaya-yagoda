// Новые письма, которых нет в данных кейса: так жюри будет проверять пилот на защите.
// Письмо добавляется в конец очереди, вся очередь пересчитывается.
import { describe, expect, it } from "vitest";
import data from "../data/case.json";
import { reconcileAll } from "./reconcile";
import type { CaseData, Letter } from "./types";

const D = data as CaseData;
function run(sender: string, text: string) {
  const l: Letter = { id: "Н-01", received: "16.11 12:30", sender, text };
  const all = reconcileAll(D, [...D.letters, l], undefined, new Set(["Н-01"]));
  return { r: all.find((x) => x.id === "Н-01")!, all, get: (id: string) => all.find((x) => x.id === id)! };
}

describe("новые письма", () => {
  it("копия с нулями и «счета» без «ё»: дубль", () => {
    const { r } = run("«Этикетка-Норд», buh@etiketka-nord.example", "Направляем копию счета № 00118 по ЗП-07 на сумму 15 000,00 руб.");
    expect(r.verdict).toBe("duplicate");
    expect(r.duplicateOf).toBe("В-12");
  });

  it("счёт на непринятые рулоны: вопрос, к оплате 0", () => {
    const { r } = run(
      "«Этикетка-Норд», buh@etiketka-nord.example",
      "Счёт 125 по ЗП-07: термоэтикетка 100×150, 2 рулона по 1000 шт., цена рулона 1500 руб. Итого 3 000 руб.",
    );
    expect(r.verdict).toBe("ask");
    expect(r.due).toBe(0);
    expect(r.conversion).toBeTruthy();
  });

  it("письмо о смене реквизитов задерживает готовый счёт", () => {
    const { r, get } = run("«Пакетная линия», invoice@paketline.example", "Просим оплату по счёту 202 перечислить на новый расчётный счёт в АО «Банк».");
    expect(r.verdict).toBe("stop");
    expect(get("В-02").verdict).toBe("ask");
    expect(get("В-02").payNow).toBe(0);
  });

  it("похожее название поставщика: стоп", () => {
    const { r } = run("«Лентапром-М», buh@lentaprom-m.example", "Счёт 60 по ЗП-08: лента клейкая 48 мм × 66 м, 100 рул. по 95 руб. Итого 9 500 руб.");
    expect(r.verdict).toBe("stop");
  });

  it("неизвестный поставщик: вопрос, не оплата", () => {
    const { r } = run("«Новый Картон», info@new-karton.example", "Счёт 7: коробка, 100 шт. по 10 руб. Итого 1 000 руб.");
    expect(r.verdict).toBe("ask");
    expect(r.payNow).toBe(0);
  });

  it("без номера заказа, ₽ вместо руб., «сумма»: находит заказ по признакам", () => {
    const { r } = run(
      "«Пакетная линия», invoice@paketline.example",
      "Счёт 215 за пакеты для ягод 500 г по заказу от 06.11: 1000 шт по 4,40 ₽, сумма 4 400 ₽",
    );
    expect(r.orderId).toBe("ЗП-13");
    expect(r.binding).toBe("attributes");
    expect(r.verdict).toBe("ask"); // цена выше заказа и всё принятое уже выставлено
  });

  it("ошибка в итоге с копейками: вернуть", () => {
    const { r } = run("«Картон-Сервис», buh@karton-servis.example", "Счёт 34 по ЗП-14: прокладка картонная 1200х800, 10 шт. по 12,00 руб. Итого 130,00 руб.");
    expect(r.verdict).toBe("return");
    expect(r.prevented).toContainEqual({ category: "arithmetic", amount: 10 });
  });

  it("чистый счёт от известного поставщика: к оплате", () => {
    // ЗП-12: принято 50 по СГ-02, выставлено 50 (В-09) → новый счёт уже не к оплате
    const { r } = run("«Этикетка-Норд», buh@etiketka-nord.example", "Счёт 130 по ЗП-12: риббон 110 мм × 300 м, 5 рул. по 650 руб. Итого 3 250 руб.");
    expect(r.verdict).toBe("ask");
    expect(r.due).toBe(0);
  });

  it("25 исходных вердиктов не меняются от постороннего письма", () => {
    const base = reconcileAll(D).map((x) => [x.id, x.verdict]);
    const { all } = run("«Новый Картон», info@new-karton.example", "Счёт 7: коробка, 100 шт. по 10 руб. Итого 1 000 руб.");
    expect(all.filter((x) => x.id !== "Н-01").map((x) => [x.id, x.verdict])).toEqual(base);
  });
});

// Демо-письма для защиты (src/data/demo-letters.ts): ожидаемые вердикты без ИИ.
import { DEMO_LETTERS } from "../data/demo-letters";
describe("демо-письма (только правила)", () => {
  // free и table: письма «для ИИ»; здесь проверяем, что без ИИ они не ломают очередь
  const expectV: Record<string, string> = {
    bank: "stop",
    copy: "duplicate",
    bags: "pay",
    total: "return",
    lookalike: "stop",
    free: "duplicate",
    table: "letter",
    forward: "duplicate",
    two: "ask",
    "same-bank": "letter",
    quote: "duplicate",
    typos: "duplicate",
  };
  for (const d of DEMO_LETTERS) {
    it(`${d.title}: ${expectV[d.id]}`, () => {
      const { r, get } = run(d.sender, d.text);
      expect(r.verdict).toBe(expectV[d.id]);
      if (d.id === "bank") expect(get("В-02").verdict).toBe("ask");
      if (d.id === "copy") expect(r.duplicateOf).toBe("В-04");
      if (d.id === "bags") {
        expect(r.orderId).toBe("ЗП-09");
        expect(r.due).toBe(63000);
        expect(get("В-13").verdict).toBe("duplicate");
      }
      if (d.id === "total") {
        expect(get("В-24").verdict).toBe("duplicate");
        expect(r.prevented).toContainEqual({ category: "arithmetic", amount: 500 });
      }
      if (d.id === "free") expect(r.duplicateOf).toBe("В-21");
      if (d.id === "table") expect(get("В-04").verdict).toBe("pay"); // без ИИ это просто письмо, очередь не меняется
      if (d.id === "forward") {
        expect(r.duplicateOf).toBe("В-02");
        expect(r.supplier).toBe("Пакетная линия");
      }
      if (d.id === "two") expect(r.ex.otherInvoices).toEqual(["126"]);
      if (d.id === "same-bank") expect(get("В-02").verdict).toBe("pay");
      if (d.id === "quote") {
        expect(r.duplicateOf).toBe("В-06");
        expect(r.addressees.some((a) => a.role === "treasurer")).toBe(true);
      }
      if (d.id === "typos") expect(r.duplicateOf).toBe("В-02");
      // ни одно демо-письмо не должно просить «условия предоплаты», если всё принятое уже выставлено
      // «two»: счёт 125 на непринятые 2 000 шт в пределах ЗП-07: там П-5 законен
      if (d.id !== "lookalike" && d.id !== "two") expect(r.findings.some((f) => f.rule === "П-5")).toBe(false);
    });
  }
});

describe("сводка по заказу и П-5", () => {
  it("лишний счёт сверх заказа: вопрос только у него, П-5 нет", () => {
    const { r, get } = run("«Лентапром», schet@lentaprom.example", "Счёт 53 по ЗП-08: лента клейкая 48 мм × 66 м, 100 рул. по 95 руб. Итого 9 500 руб.");
    expect(r.verdict).toBe("ask");
    expect(r.findings.some((f) => f.rule === "П-5")).toBe(false);
    expect(r.findings.some((f) => f.rule === "П-3" && f.level === "ask")).toBe(true);
    expect(get("В-04").verdict).toBe("pay");
    expect(get("В-04").payNow).toBe(34200);
  });
  it("непринятый товар в пределах заказа: П-5 остаётся", () => {
    // ЗП-07: заказано 12 000, принято и выставлено 10 000: новые 2 000 шт в пределах заказа, но не приняты
    const { r } = run("«Этикетка-Норд», buh@etiketka-nord.example", "Счёт 125 по ЗП-07: термоэтикетка 100×150, 2 рулона по 1000 шт., цена рулона 1500 руб. Итого 3 000 руб.");
    expect(r.findings.some((f) => f.rule === "П-5")).toBe(true);
  });
});
