export class DatabaseConfigurationError extends Error {
  constructor() {
    super("A valid server-side DATABASE_URL is required.");
    this.name = "DatabaseConfigurationError";
  }
}

/**
 * Keep configuration lazy so the shell can boot without database credentials.
 * Only the database health check (or a future DB operation) requires this value.
 * This module is also used by Drizzle's Node CLI; never import it in client UI.
 */
export function readDatabaseConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new DatabaseConfigurationError();

  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
      throw new DatabaseConfigurationError();
    }
  } catch {
    // Do not include the connection string or parser error in the exception.
    throw new DatabaseConfigurationError();
  }

  return { connectionString };
}