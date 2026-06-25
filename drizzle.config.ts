import { defineConfig } from 'drizzle-kit'

// Used by `drizzle-kit generate` to diff core/schema.ts into versioned migrations
// under drizzle/. The app applies them at runtime; the url here is only for
// drizzle-kit's own tooling (studio/migrate) against a local dev db.
export default defineConfig({
  dialect: 'sqlite',
  schema: './core/schema.ts',
  out: './drizzle',
  dbCredentials: { url: 'bus.db' },
})
