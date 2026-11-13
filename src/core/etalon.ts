// Ручная эталонная разметка (data/case04_etalon.md) в виде данных: для тестов и экрана «Проверка на эталоне».
import type { Role, Verdict } from "./types";

export type EtalonRow = {
  id: string;
  verdict: Verdict;
  order: string | null;
  invoiced: number | null;
  due: number | null; // «Должно быть» из эталона; null: не применимо
  to: Role[]; // адресаты (роли)
  rules?: string[]; // правила, которые должны прозвучать в причинах
  related?: string[];
  binding?: "number" | "attributes" | "probable";
};

// Отличия от буквы эталона: решения команды (docs/decisions.md):
//  - В-13, В-21: в эталоне «⚠️/↩️» → «вопрос» закупщику (как В-10).
//  - В-25: в эталоне «🚫/ℹ️» → «стоп»: письмо требует эскалации ФД, а не просто контекст.
export const ETALON: EtalonRow[] = [
  { id: "В-01", verdict: "pay", order: "ЗП-10", invoiced: 44000, due: 44000, to: [], rules: ["П-1"], binding: "attributes" },
  { id: "В-02", verdict: "pay", order: "ЗП-06", invoiced: 15000, due: 15000, to: [] },
  { id: "В-03", verdict: "duplicate", order: "ЗП-03", invoiced: 36000, due: null, to: [], rules: ["П-3"], related: ["В-06"] },
  { id: "В-04", verdict: "pay", order: "ЗП-08", invoiced: 34200, due: 34200, to: [], rules: ["П-1"] },
  { id: "В-05", verdict: "ask", order: "ЗП-11", invoiced: 14000, due: 14000, to: ["buyer", "cfo"], rules: ["П-2"], related: ["В-25"] },
  { id: "В-06", verdict: "pay", order: "ЗП-03", invoiced: 36000, due: 36000, to: [], rules: ["П-7"] },
  { id: "В-07", verdict: "ask", order: "ЗП-01", invoiced: 40000, due: 32000, to: ["buyer"], rules: ["П-4", "П-5"], related: ["В-23"] },
  { id: "В-08", verdict: "pay", order: "ЗП-02", invoiced: 55000, due: 55000, to: [], rules: ["П-6"] },
  { id: "В-09", verdict: "pay", order: "ЗП-12", invoiced: 32500, due: 32500, to: [], rules: ["П-7"] },
  { id: "В-10", verdict: "ask", order: "ЗП-04", invoiced: 13200, due: 12000, to: ["buyer"], rules: ["П-6", "П-1"], related: ["В-11"] },
  { id: "В-11", verdict: "letter", order: "ЗП-04", invoiced: null, due: null, to: [], related: ["В-10"] },
  { id: "В-12", verdict: "pay", order: "ЗП-07", invoiced: 15000, due: 15000, to: [], rules: ["П-7"], related: ["В-20"] },
  { id: "В-13", verdict: "ask", order: "ЗП-09", invoiced: 67500, due: 63000, to: ["buyer"], rules: ["П-6"] },
  { id: "В-14", verdict: "duplicate", order: "ЗП-06", invoiced: 15000, due: 0, to: [], rules: ["П-3"], related: ["В-02"] },
  { id: "В-15", verdict: "return", order: "ЗП-08", invoiced: 23800, due: 22800, to: ["supplier"], rules: ["П-8"] },
  { id: "В-16", verdict: "stop", order: "ЗП-01", invoiced: 40000, due: 0, to: ["buyer", "cfo"], rules: ["П-2"], binding: "probable" },
  { id: "В-17", verdict: "ask", order: "ЗП-05", invoiced: 72000, due: 0, to: ["buyer"], rules: ["П-4", "П-5"], related: ["В-19"] },
  { id: "В-18", verdict: "duplicate", order: "ЗП-01", invoiced: 40000, due: 0, to: ["treasurer"], rules: ["П-3"], related: ["В-07"] },
  { id: "В-19", verdict: "letter", order: "ЗП-05", invoiced: null, due: null, to: [], rules: ["П-4"], related: ["В-17"] },
  { id: "В-20", verdict: "letter", order: "ЗП-07", invoiced: null, due: null, to: [], related: ["В-12"] },
  { id: "В-21", verdict: "ask", order: "ЗП-13", invoiced: 17600, due: 16000, to: ["buyer"], rules: ["П-6"] },
  { id: "В-22", verdict: "duplicate", order: "ЗП-12", invoiced: 32500, due: 0, to: [], rules: ["П-3"], related: ["В-09"] },
  { id: "В-23", verdict: "ask", order: "ЗП-01", invoiced: 8000, due: 0, to: ["buyer"], rules: ["П-4"], related: ["В-07"] },
  { id: "В-24", verdict: "ask", order: "ЗП-14", invoiced: 6480, due: 6000, to: ["buyer", "warehouse"], rules: ["П-6"] },
  { id: "В-25", verdict: "stop", order: "ЗП-11", invoiced: null, due: null, to: ["buyer", "cfo"], rules: ["П-2"], related: ["В-05"] },
];

export const BUYERS: Record<string, string> = { "В-07": "Олег Смирнов", "В-10": "Олег Смирнов", "В-13": "Дмитрий Орлов", "В-16": "Олег Смирнов", "В-17": "Олег Смирнов", "В-21": "Анна Ковалёва", "В-05": "Анна Ковалёва", "В-24": "Олег Смирнов", "В-25": "Анна Ковалёва" };


export const ETALON_TOTALS = { payNowCount: 7, payNow: 231700, prevented: { duplicate: 87500, fraud: 40000, price: 7300, arithmetic: 1000 }, preventedTotal: 135800, deferred: 88480, held: 14000 };
