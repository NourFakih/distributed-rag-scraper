import type { Request, Response } from "express";

import type { AskBody } from "../schemas/ask.schemas";
import { answerQuestion } from "../services/ask.service";

export async function askController(
  request: Request,
  response: Response,
): Promise<void> {
  const body = request.body as AskBody;
  response.status(200).json(
    await answerQuestion(body.question, body.limit),
  );
}
