import { PrismaClient } from '../generated/prisma/client';

// Single shared Prisma client for the whole process.
export const prisma = new PrismaClient();
