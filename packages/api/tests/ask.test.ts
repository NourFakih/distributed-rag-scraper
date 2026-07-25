import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  answerQuestion: vi.fn(),
}));

vi.mock("../src/services/ask.service", () => ({
  answerQuestion: mocks.answerQuestion,
}));

import { createApp } from "../app";

const responseContract = {
  question: "What are the book prices?",
  answer: "The indexed listing displays a $10 price [1].",
  grounded: true,
  model: {
    provider: "openai-compatible",
    model: "fixture-model",
  },
  retrieval: {
    requestedLimit: 5,
    resultCount: 1,
  },
  citations: [
    {
      number: 1,
      chunkId: "00000000-0000-4000-8000-000000000001",
      documentId: "00000000-0000-4000-8000-000000000010",
      chunkIndex: 0,
      url: "https://example.com/books",
      title: "Books",
      excerpt: "The displayed price is $10.",
      similarity: 0.91,
    },
  ],
};

describe("POST /api/ask", () => {
  const app = createApp();

  beforeEach(() => {
    mocks.answerQuestion.mockResolvedValue(responseContract);
  });

  it("trims the question, defaults the limit, and returns the stable contract", async () => {
    const response = await request(app)
      .post("/api/ask")
      .send({
        question: "  What are the book prices?  ",
      });

    expect(response.status).toBe(200);
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      "What are the book prices?",
      5,
    );
    expect(response.body).toEqual(responseContract);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("embedding");
    expect(serialized).not.toContain("test-secret-key");
  });

  it.each([
    {},
    {
      question: 42,
    },
    {
      question: " ",
    },
    {
      question: "x".repeat(2_001),
    },
    {
      question: "valid",
      limit: 0,
    },
    {
      question: "valid",
      limit: 11,
    },
    {
      question: "valid",
      limit: 1.5,
    },
    {
      question: "valid",
      limit: 5,
      extra: true,
    },
  ])("returns the standard 422 validation response", async (body) => {
    const response = await request(app).post("/api/ask").send(body);

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
    });
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
  });

  it("returns a controlled invalid-JSON response", async () => {
    const response = await request(app)
      .post("/api/ask")
      .set("Content-Type", "application/json")
      .send('{"question":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "INVALID_JSON",
        message: "Request body contains invalid JSON",
      },
    });
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
  });
});
