import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const runs = await prisma.syncRun.findMany({orderBy:{startedAt:'desc'}, take: 1, select: { errorMessage: true, status: true, processedItems: true, totalItems: true }});
  const err = runs[0].errorMessage;
  console.log('ERROR IS:', err ? err.substring(0, 800) : 'none');
}
main();
