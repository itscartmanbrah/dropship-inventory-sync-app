import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const runs = await prisma.syncRun.findMany({orderBy:{startedAt:'desc'}, take: 1, select: { errorMessage: true }});
  console.log(runs[0].errorMessage);
}
main();
