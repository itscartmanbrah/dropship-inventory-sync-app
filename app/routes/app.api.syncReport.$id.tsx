import { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { id } = params;

  if (!id) {
    return new Response("Missing ID", { status: 400 });
  }

  const syncRun = await prisma.syncRun.findUnique({
    where: { id, shop: session.shop }
  });

  if (!syncRun || !syncRun.reportData) {
    return new Response("Report not found or empty", { status: 404 });
  }

  return new Response(syncRun.reportData, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sync_report_${id}.csv"`,
    },
  });
};
