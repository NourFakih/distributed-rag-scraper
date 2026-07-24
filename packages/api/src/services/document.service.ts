import { prisma } from "@distributed-rag/shared";

import { AppError } from "../middleware/error-handler";

export async function getDocumentById(id: string) {
  const document = await prisma.document.findUnique({
    where: {
      id,
    },
    include: {
      crawlPage: {
        select: {
          crawlId: true,
        },
      },
    },
  });

  if (!document) {
    throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document was not found");
  }

  return document;
}
