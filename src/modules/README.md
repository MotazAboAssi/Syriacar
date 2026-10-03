# Domain module boundary

This directory is intentionally code-free during the technical foundation phase.
Future authorized domain modules belong here, with their own application/domain
code and persistence adapters. They must not import Next.js route handlers or UI.
No business entities, features, schema, seed data, or migrations exist yet.