import { unauthenticated } from './app/shopify.server';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const settings = await prisma.settings.findFirst();
  const shop = settings.shop;
  console.log('Shop:', shop);
  
  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(
    `#graphql
    query {
      productVariants(first: 5) {
        edges {
          node {
            sku
            title
            inventoryItem {
              id
              inventoryLevels(first: 10) {
                edges {
                  node {
                    location {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`
  );
  
  const data = await response.json();
  console.dir(data.data.productVariants.edges, {depth: null});
}
main();
