import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const settings = await prisma.settings.findFirst();
  console.log('SETTINGS SHOP:', settings?.shop);
  console.log('LOCATION ID:', settings?.locationId);
}
main();
