import { prisma } from "@distributed-rag/shared";

import { AppError } from "../middleware/error-handler";

export async function getCrawlDeadLetters(
  crawlId: string,
  page: number,
  pageSize: number,
) {
  const crawl = await prisma.crawl.findUnique({
    where: {
      id: crawlId,
    },
    select: {
      id: true,
    },
  });
  if (!crawl) {
    throw new AppError(404, "CRAWL_NOT_FOUND", "Crawl was not found");
  }

  const [deadLetters, total] = await prisma.$transaction([
    prisma.deadLetter.findMany({
      where: {
        crawlId,
      },
      orderBy: [
        {
          failedAt: "desc",
        },
        {
          id: "asc",
        },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.deadLetter.count({
      where: {
        crawlId,
      },
    }),
  ]);

  return {
    deadLetters,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

export async function getDeadLetterById(id: string) {
  const deadLetter = await prisma.deadLetter.findUnique({
    where: {
      id,
    },
  });

  if (!deadLetter) {
    throw new AppError(
      404,
      "DEAD_LETTER_NOT_FOUND",
      "Dead letter was not found",
    );
  }

  return deadLetter;
}
