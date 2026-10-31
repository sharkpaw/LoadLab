import { Redis } from 'ioredis';
import { config } from './config.js';

export function createRedis(): Redis {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
}

export const redis = createRedis();

export const keys = {
  queueWake: 'loadlab:queue:wake',
  live: (runId: string) => `loadlab:live:${runId}`,
  control: (runId: string) => `loadlab:control:${runId}`,
  steps: (runId: string) => `loadlab:steps:${runId}`,
  latest: (runId: string) => `loadlab:latest:${runId}`,
  workerHb: (workerId: string) => `loadlab:worker:${workerId}`,
  nodes: 'loadlab:nodes',
  // distributed runs: helper slot ownership, helper → lead messages, synchronized start time
  shard: (runId: string, idx: number) => `loadlab:shard:${runId}:${idx}`,
  inbox: (runId: string) => `loadlab:inbox:${runId}`,
  go: (runId: string) => `loadlab:go:${runId}`,
};

/** Multiple listeners per channel over a single subscriber connection. */
export class Fanout {
  private sub = createRedis();
  private listeners = new Map<string, Set<(msg: string) => void>>();

  constructor() {
    this.sub.on('message', (channel: string, msg: string) => {
      this.listeners.get(channel)?.forEach((fn) => fn(msg));
    });
  }

  async on(channel: string, fn: (msg: string) => void): Promise<() => Promise<void>> {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.sub.subscribe(channel);
    }
    set.add(fn);
    return async () => {
      const s = this.listeners.get(channel);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) {
        this.listeners.delete(channel);
        await this.sub.unsubscribe(channel).catch(() => {});
      }
    };
  }
}
