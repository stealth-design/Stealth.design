import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres",
  },
  // Keep generated SQL reviewable: one statement per line, explicit names.
  verbose: true,
  strict: true,
  casing: "snake_case",
});
