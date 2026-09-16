import { PrismaClient } from "@prisma/client";

// Always create a fresh PrismaClient — avoids stale cached clients in dev
// that don't have newly migrated models available.
const createClient = () => new PrismaClient();

let prisma;

if (process.env.NODE_ENV !== "production") {
  // Always recreate PrismaClient on module reload in dev to pick up schema changes
  global.__prisma = createClient();
  prisma = global.__prisma;
} else {
  prisma = createClient();
}

export default prisma;
