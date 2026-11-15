// Прогон 50 писем с ловушками (trap-letters.ts): каждое письмо отдельно поверх исходных 25.
import { describe, expect, it } from "vitest";
import data from "../data/case.json";
import { reconcileAll } from "./reconcile";
import { TRAP_LETTERS, type TrapLetter } from "./trap-letters";
import { TRAP_LETTERS_2 } from "./trap-letters-2";
import type { CaseData, Letter, Result } from "./types";

const D = data as CaseData;

export function runTrap(t: TrapLetter) {
  const l: Letter = { id: "Н-01", received: "16.11 12:30", sender: t.sender, text: t.text };
  const all = reconcileAll(D, [...D.letters, l], undefined, new Set(["Н-01"]));
  const get = (id: string) => all.find((x) => x.id === id)!;
  return { r: get("Н-01"), get };
}

/** Что не так с ответом ядра: пустой список, если всё по правилам. */
export function trapProblems(t: TrapLetter, r: Result, get: (id: string) => Result): string[] {
  const e = t.expect;
  const p: string[] = [];
  if (!e.verdict.includes(r.verdict)) p.push(`вердикт «${r.verdict}», ожидался «${e.verdict.join(" / ")}»`);
  if (e.payNow !== undefined && r.verdict === "pay" && r.payNow !== e.payNow) p.push(`к оплате ${r.payNow}, ожидалось ${e.payNow}`);
  if (e.due !== undefined && r.due !== e.due) p.push(`«должно быть» ${r.due}, ожидалось ${e.due}`);
  if (e.orderId !== undefined && r.orderId !== e.orderId) p.push(`заказ ${r.orderId ?? "не найден"}, ожидался ${e.orderId}`);
  if (e.duplicateOf !== undefined && (r.duplicateOf ?? null) !== e.duplicateOf) p.push(e.duplicateOf ? `дубль ${r.duplicateOf ?? "не найден"}, ожидался дубль ${e.duplicateOf}` : `ошибочно дубль ${r.duplicateOf}`);
  const extra = e.check?.(r, get);
  if (extra) p.push(extra);
  return p;
}

describe("письма с ловушками", () => {
  for (const t of [...TRAP_LETTERS, ...TRAP_LETTERS_2]) {
    it(`${t.id} ${t.group}: ${t.trap}`, () => {
      const { r, get } = runTrap(t);
      expect(trapProblems(t, r, get), `ядро: ${r.verdict}, ${r.headline}`).toEqual([]);
    });
  }
});
