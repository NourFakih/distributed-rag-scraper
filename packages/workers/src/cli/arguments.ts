export const DEFAULT_BACKFILL_BATCH_SIZE = 25;
export const MAX_BACKFILL_BATCH_SIZE = 500;
export const MAX_BACKFILL_LIMIT = 1_000_000;

export interface BackfillArguments {
  batchSize: number;
  limit?: number;
}

function positiveInteger(
  name: string,
  raw: string | undefined,
  maximum: number,
): number {
  if (raw === undefined || !/^\d+$/u.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

export function parseBackfillArguments(
  argv: readonly string[],
): BackfillArguments {
  let batchSize = DEFAULT_BACKFILL_BATCH_SIZE;
  let limit: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const [flag, inlineValue] = argument.split("=", 2);
    if (flag !== "--batch-size" && flag !== "--limit") {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const value =
      inlineValue ??
      (() => {
        index += 1;
        return argv[index];
      })();
    if (flag === "--batch-size") {
      batchSize = positiveInteger(
        "--batch-size",
        value,
        MAX_BACKFILL_BATCH_SIZE,
      );
    } else {
      limit = positiveInteger("--limit", value, MAX_BACKFILL_LIMIT);
    }
  }

  return {
    batchSize,
    ...(limit === undefined ? {} : { limit }),
  };
}
