import { PrismaClient } from "@prisma/client";

// Always create a fresh PrismaClient — avoids stale cached clients in dev
// that don't have newly migrated models available.
const createClient = () => new PrismaClient();

let prisma;

if (process.env.NODE_ENV !== "production") {
  // In dev, store on global to survive HMR but clear it so schema changes
  // picked up after a full process restart take effect.
  if (!global.__prisma) {
    global.__prisma = createClient();
  }
  prisma = global.__prisma;
} else {
  prisma = createClient();
}

export default prisma;
