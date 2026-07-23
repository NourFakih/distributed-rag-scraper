import { PrismaClient } from "@prisma/client";

declare global {
  var distributedRagPrisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.distributedRagPrisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.distributedRagPrisma = prisma;
}

export async function closePrisma(): Promise<void> {
  await prisma.$disconnect();
}
