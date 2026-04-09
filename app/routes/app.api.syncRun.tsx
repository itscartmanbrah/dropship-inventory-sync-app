import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const latestRun = await prisma.syncRun.findFirst({
    where: { shop },
    orderBy: { startedAt: "desc" },
  });

  return json({ latestRun });
};
