// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  searchIndex: vi.fn(),
  askQuestion: vi.fn(),
}));

vi.mock("../src/api/client", () => ({
  ApiError: class ApiError extends Error {},
  searchIndex: apiMocks.searchIndex,
  askQuestion: apiMocks.askQuestion,
}));

import { AskSection } from "../src/components/AskSection";
import { SearchSection } from "../src/components/SearchSection";

afterEach(() => cleanup());

const baseResult = {
  chunkId: "00000000-0000-4000-8000-000000000001",
  documentId: "00000000-0000-4000-8000-000000000010",
  chunkIndex: 2,
  url: "https://example.com/books",
  title: "Book catalog",
  excerpt: "The displayed book price is $10.",
};

describe("search dashboard", () => {
  beforeEach(() => {
    apiMocks.searchIndex.mockResolvedValue({
      data: {
        query: "books",
        mode: "semantic",
        resultCount: 0,
        results: [],
      },
    });
  });

  it("switches between semantic and keyword search modes", async () => {
    const user = userEvent.setup();
    render(<SearchSection />);

    await user.type(screen.getByLabelText("Search query"), "books");
    await user.selectOptions(screen.getByLabelText("Search mode"), "keyword");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(apiMocks.searchIndex).toHaveBeenCalledWith("books", "keyword", 5);
  });

  it("renders keyword relevance results", async () => {
    apiMocks.searchIndex.mockResolvedValueOnce({
      data: {
        query: "book price",
        mode: "keyword",
        resultCount: 1,
        results: [{ ...baseResult, relevance: 0.87 }],
      },
    });
    const user = userEvent.setup();
    render(<SearchSection />);

    await user.type(screen.getByLabelText("Search query"), "book price");
    await user.selectOptions(screen.getByLabelText("Search mode"), "keyword");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Book catalog")).toBeInTheDocument();
    expect(screen.getByText("Relevance 0.870")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://example.com/books" })).toHaveAttribute(
      "href",
      "https://example.com/books",
    );
  });

  it("renders semantic similarity results", async () => {
    apiMocks.searchIndex.mockResolvedValueOnce({
      data: {
        query: "book prices",
        mode: "semantic",
        resultCount: 1,
        results: [{ ...baseResult, similarity: 0.93 }],
      },
    });
    const user = userEvent.setup();
    render(<SearchSection />);

    await user.type(screen.getByLabelText("Search query"), "book prices");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Similarity 0.930")).toBeInTheDocument();
    expect(screen.getByText("Chunk 2")).toBeInTheDocument();
  });
});

describe("grounded answer dashboard", () => {
  it("renders a grounded answer and clickable citations", async () => {
    apiMocks.askQuestion.mockResolvedValueOnce({
      question: "What is the price?",
      answer: "The displayed price is $10 [1].",
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
          ...baseResult,
          similarity: 0.93,
        },
      ],
    });
    const user = userEvent.setup();
    render(<AskSection />);

    await user.type(screen.getByLabelText("Question"), "What is the price?");
    await user.click(screen.getByRole("button", { name: "Ask indexed sources" }));

    expect(await screen.findByText("The displayed price is $10 [1].")).toBeInTheDocument();
    expect(screen.getByText("fixture-model")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Book catalog" })).toHaveAttribute(
      "href",
      "https://example.com/books",
    );
  });

  it("clearly renders the insufficient-evidence state", async () => {
    apiMocks.askQuestion.mockResolvedValueOnce({
      question: "Future forecast?",
      answer: "I could not find enough relevant information in the indexed documents to answer this question.",
      grounded: false,
      model: null,
      retrieval: {
        requestedLimit: 5,
        resultCount: 0,
      },
      citations: [],
    });
    const user = userEvent.setup();
    render(<AskSection />);

    await user.type(screen.getByLabelText("Question"), "Future forecast?");
    await user.click(screen.getByRole("button", { name: "Ask indexed sources" }));

    expect(await screen.findByText("Insufficient evidence")).toBeInTheDocument();
    expect(screen.getByText(/could not find enough relevant information/u)).toBeInTheDocument();
    expect(screen.queryByText("Citations")).not.toBeInTheDocument();
  });
});
