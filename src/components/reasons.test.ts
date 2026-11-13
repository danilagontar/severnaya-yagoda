// Фильтры очереди «Причина» и «Кому» на данных кейса.
import { expect, it } from "vitest";
import data from "../data/case.json";
import { reconcileAll } from "@/core/reconcile";
import type { CaseData } from "@/core/types";
import { REASONS, addresseeKey, reasonsOf } from "./Queue";

const rs = reconcileAll(data as CaseData);
const by = (id: string) => rs.filter((r) => reasonsOf(r).includes(id)).map((r) => r.id).sort();

it("причины раскладываются по документам эталона", () => {
  expect(by("price")).toEqual(["В-10", "В-13", "В-21"]);
  expect(by("accept")).toEqual(["В-07", "В-17", "В-23"]);
  expect(by("over")).toEqual(["В-07", "В-23", "В-24"]);
  expect(by("requisites")).toEqual(["В-05", "В-16", "В-25"]);
  expect(by("dup")).toEqual(["В-03", "В-14", "В-18", "В-22"]);
  expect(by("total")).toEqual(["В-15"]);
  expect(REASONS.length).toBe(8);
});

it("«Кому»: у Олега Смирнова 6 документов", () => {
  expect(rs.filter((r) => r.addressees.some((a) => addresseeKey(a) === "Олег Смирнов")).length).toBe(6);
});
