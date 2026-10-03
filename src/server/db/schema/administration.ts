import { boolean, index, json, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { opsRole } from "./enums.ts";

export const opsUsers = pgTable("ops_users", {
  id: uuid("id").primaryKey(),
  name: varchar("name").notNull(),
  username: varchar("username").notNull().unique("ops_users_username_unique"),
  passwordHash: varchar("password_hash").notNull(),
  role: opsRole("role").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey(),
  opsUserId: uuid("ops_user_id").notNull().references(() => opsUsers.id),
  action: varchar("action").notNull(),
  entityType: varchar("entity_type").notNull(),
  entityId: varchar("entity_id").notNull(),
  oldValue: json("old_value"),
  newValue: json("new_value"),
  createdAt: timestamp("created_at").notNull(),
}, (t) => [index("audit_log_ops_created_idx").on(t.opsUserId, t.createdAt)]);

export const messageTemplates = pgTable("message_templates", {
  id: uuid("id").primaryKey(),
  key: varchar("key").notNull().unique("message_templates_key_unique"),
  templateAr: text("template_ar").notNull(),
  updatedBy: uuid("updated_by").notNull().references(() => opsUsers.id),
  updatedAt: timestamp("updated_at").notNull(),
}, (t) => [index("message_templates_updated_by_idx").on(t.updatedBy)]);

export const systemConfig = pgTable("system_config", {
  key: varchar("key").primaryKey(),
  value: varchar("value").notNull(),
  updatedBy: uuid("updated_by").notNull().references(() => opsUsers.id),
  updatedAt: timestamp("updated_at").notNull(),
}, (t) => [index("system_config_updated_by_idx").on(t.updatedBy)]);