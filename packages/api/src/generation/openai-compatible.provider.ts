import {
  loadGenerationConfig,
  type GenerationConfig,
} from "./generation-config";
import {
  GenerationProviderError,
  GenerationResponseError,
  GenerationTimeoutError,
  type GenerationProvider,
  type GroundedGenerationInput,
} from "./generation-provider";
import {
  buildGroundingUserPrompt,
  GROUNDING_SYSTEM_PROMPT,
} from "./grounding-prompt";

export type GenerationFetch = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

export class OpenAICompatibleGenerationProvider
  implements GenerationProvider
{
  public readonly providerId = "openai-compatible";
  public readonly modelId: string;

  public constructor(
    private readonly config: GenerationConfig,
    private readonly request: GenerationFetch = fetch,
  ) {
    this.modelId = config.model;
  }

  public async generateGroundedAnswer(
    input: GroundedGenerationInput,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.request(
        `${this.config.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [
              {
                role: "system",
                content: GROUNDING_SYSTEM_PROMPT,
              },
              {
                role: "user",
                content: buildGroundingUserPrompt(input),
              },
            ],
            temperature: 0.1,
            max_tokens: this.config.maxOutputTokens,
            stream: false,
          }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        },
      );
    } catch (error: unknown) {
      if (
        error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new GenerationTimeoutError(
          `Generation exceeded the configured ${this.config.timeoutMs} ms timeout`,
          { cause: error },
        );
      }
      throw new GenerationProviderError(
        "The configured generation provider could not be reached",
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new GenerationProviderError(
        `The generation provider returned HTTP ${response.status}`,
      );
    }

    let payload: ChatCompletionResponse;
    try {
      payload = (await response.json()) as ChatCompletionResponse;
    } catch (error: unknown) {
      throw new GenerationResponseError(
        "The generation provider returned malformed JSON",
        { cause: error },
      );
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new GenerationResponseError(
        "The generation provider returned an empty or malformed answer",
      );
    }
    return content.trim();
  }
}

let provider: OpenAICompatibleGenerationProvider | undefined;

export function getGenerationProvider(): OpenAICompatibleGenerationProvider {
  provider ??= new OpenAICompatibleGenerationProvider(
    loadGenerationConfig(),
  );
  return provider;
}

export function resetGenerationProviderForTests(): void {
  provider = undefined;
}
