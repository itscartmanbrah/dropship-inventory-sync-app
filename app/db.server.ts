import { PrismaClient } from "@prisma/client";
import { startScheduler } from "./services/scheduler.server";

declare global {
  var prismaGlobal: PrismaClient;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

// Start the scheduler exactly once
startScheduler();

export default prisma;
