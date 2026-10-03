import { boolean, index, pgTable, smallint, uuid, varchar } from "drizzle-orm/pg-core";

export const governorates = pgTable("governorates", {
  id: uuid("id").primaryKey(),
  nameAr: varchar("name_ar").notNull(),
  isActive: boolean("is_active").notNull(),
});

export const regions = pgTable("regions", {
  id: uuid("id").primaryKey(),
  governorateId: uuid("governorate_id").notNull().references(() => governorates.id),
  nameAr: varchar("name_ar").notNull(),
  isActive: boolean("is_active").notNull(),
}, (t) => [index("regions_governorate_idx").on(t.governorateId)]);

export const brandGroups = pgTable("brand_groups", {
  id: uuid("id").primaryKey(),
  nameAr: varchar("name_ar").notNull(),
  displayOrder: smallint("display_order").notNull(),
  isActive: boolean("is_active").notNull(),
});

export const brands = pgTable("brands", {
  id: uuid("id").primaryKey(),
  brandGroupId: uuid("brand_group_id").notNull().references(() => brandGroups.id),
  nameAr: varchar("name_ar").notNull(),
  displayOrder: smallint("display_order").notNull(),
  isActive: boolean("is_active").notNull(),
}, (t) => [index("brands_brand_group_idx").on(t.brandGroupId)]);

export const fuelTypes = pgTable("fuel_types", {
  id: uuid("id").primaryKey(),
  code: varchar("code").notNull().unique("fuel_types_code_unique"),
  nameAr: varchar("name_ar").notNull(),
  displayOrder: smallint("display_order").notNull(),
  isActive: boolean("is_active").notNull().default(true),
});

export const towTypes = pgTable("tow_types", {
  id: uuid("id").primaryKey(),
  code: varchar("code").notNull().unique("tow_types_code_unique"),
  nameAr: varchar("name_ar").notNull(),
  displayOrder: smallint("display_order").notNull(),
  isActive: boolean("is_active").notNull().default(true),
});