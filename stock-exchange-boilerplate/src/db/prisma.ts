import { PrismaClient } from '../generated/prisma/client';

// Single shared Prisma client for the whole process.
export const prisma = new PrismaClient();

/** Cheap round-trip used by the readiness probe and by startup to wait for Postgres. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
