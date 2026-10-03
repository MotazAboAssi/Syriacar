import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { referenceId, referenceSeed as data } from "../src/server/db/seed/reference-data.ts";

// Compare independently against the owner's approved brief, not the seed itself.
const brief = readFileSync(new URL(
  "../attached_assets/Pasted-Build-3-Implement-the-approved-initial-reference-data-s_1791064142979.txt", import.meta.url,
), "utf8");
const section = (start, end) => brief.slice(brief.indexOf(start), brief.indexOf(end));
const numbered = (text) => [...text.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
const groups = (text) => [...text.matchAll(/^([^\n]+):\n((?:- [^\n]+\n)+)/gm)]
  .map((m) => ({ name: m[1], entries: m[2].split("\n").filter((x) => x.startsWith("- ")).map((x) => x.slice(2)) }));

test("approved initial reference inventory contains exactly 158 rows", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length])), {
    governorates: 14, regions: 76, brand_groups: 9, brands: 49, fuel_types: 5, tow_types: 5,
  });
  assert.ok(Object.values(data).flat().every((row) => row.isActive === true));
});

test("all owner-supplied governorates and region names/relationships are retained verbatim", () => {
  assert.deepEqual(data.governorates.map((g) => g.nameAr), numbered(section("A. GOVERNORATES", "B. REGIONS")));
  for (const group of groups(section("B. REGIONS", "C. FUEL TYPES"))) {
    const parent = data.governorates.find((g) => g.nameAr === group.name);
    assert.ok(parent, group.name);
    assert.deepEqual(data.regions.filter((r) => r.governorateId === parent.id).map((r) => r.nameAr),
      group.entries, group.name);
  }
  assert.ok(data.regions.every((r) => data.governorates.some((g) => g.id === r.governorateId)));
  // Same label in different governorates is intentionally two different records.
  const qudsaya = data.regions.filter((r) => r.nameAr === "قدسيا");
  assert.equal(qudsaya.length, 2);
  assert.notEqual(qudsaya[0].id, qudsaya[1].id);
  assert.notEqual(qudsaya[0].governorateId, qudsaya[1].governorateId);
});

test("approved Arabic group labels and all 49 brands retain their grouping and ordering", () => {
  assert.deepEqual(data.brand_groups.map((g) => g.nameAr),
    ["كوري", "ياباني", "صيني", "إيراني", "ألماني", "فرنسي", "إيطالي", "سويدي / بريطاني", "أمريكي"]);
  const approved = groups(section("E. BRAND GROUPS AND BRANDS", "OPERATIONS MANAGEMENT:"));
  assert.equal(approved.length, data.brand_groups.length);
  for (const [index, parent] of data.brand_groups.entries()) {
    assert.equal(parent.displayOrder, index + 1);
    const children = data.brands.filter((b) => b.brandGroupId === parent.id);
    assert.deepEqual(children.map((b) => b.nameAr), approved[index].entries, approved[index].name);
    assert.deepEqual(children.map((b) => b.displayOrder), children.map((_, i) => i + 1));
  }
  assert.ok(data.brands.every((b) => data.brand_groups.some((g) => g.id === b.brandGroupId)));
});

test("fuel and tow display values/order exactly match the new owner-approved lists", () => {
  assert.deepEqual(data.fuel_types.map((r) => r.nameAr), numbered(section("C. FUEL TYPES", "D. TOW TYPES")));
  assert.deepEqual(data.tow_types.map((r) => r.nameAr), numbered(section("D. TOW TYPES", "E. BRAND GROUPS AND BRANDS")));
  for (const rows of [data.fuel_types, data.tow_types]) {
    assert.deepEqual(rows.map((r) => r.displayOrder), [1, 2, 3, 4, 5]);
    assert.equal(new Set(rows.map((r) => r.code)).size, rows.length);
  }
  assert.deepEqual(data.fuel_types.map((r) => r.code), ["petrol", "diesel", "cng", "hybrid", "electric"]);
  assert.deepEqual(data.tow_types.map((r) => r.code), ["hydraulic", "ordinary", "winch", "closed", "two_wheel"]);
});

test("all seed IDs are unique stable UUIDv5 values, scoped independently of display names", () => {
  const ids = Object.values(data).flat().map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)));
  assert.equal(referenceId("governorate/damascus"), data.governorates[0].id);
  assert.equal(referenceId("governorate/damascus"), referenceId("governorate/damascus"));
  assert.notEqual(referenceId("governorate/damascus"), referenceId("governorate/rural-damascus"));
});