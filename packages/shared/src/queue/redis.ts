import IORedis from "ioredis";

const DEFAULT_REDIS_URL = "redis://localhost:6379";

export function createRedisConnection(connectionName: string): IORedis {
  return new IORedis(process.env.REDIS_URL ?? DEFAULT_REDIS_URL, {
    connectionName,
    enableReadyCheck: true,
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
}

