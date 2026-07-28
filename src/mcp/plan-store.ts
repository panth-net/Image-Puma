import { randomUUID } from 'crypto';
import type { StoredMcpPlan } from './types';
import { ImagePumaMcpError } from './types';

export interface McpPlanStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class InMemoryMcpPlanStore {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly plans = new Map<string, StoredMcpPlan>();

  constructor(options: McpPlanStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 50;
    this.now = options.now ?? Date.now;
  }

  create(input: Omit<StoredMcpPlan, 'planId' | 'createdAt' | 'expiresAt'>): StoredMcpPlan {
    this.pruneExpired();

    const createdAt = this.now();
    const storedPlan: StoredMcpPlan = {
      ...input,
      planId: randomUUID(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };

    this.plans.set(storedPlan.planId, storedPlan);
    this.evictOverflow();
    return storedPlan;
  }

  get(planId: string): StoredMcpPlan {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new ImagePumaMcpError('PLAN_NOT_FOUND', `No stored Image Puma plan exists for planId: ${planId}`);
    }

    if (plan.expiresAt <= this.now()) {
      this.plans.delete(planId);
      throw new ImagePumaMcpError('PLAN_EXPIRED', `Image Puma plan has expired: ${planId}`);
    }

    return plan;
  }

  delete(planId: string): void {
    this.plans.delete(planId);
  }

  clear(): void {
    this.plans.clear();
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [planId, plan] of this.plans.entries()) {
      if (plan.expiresAt <= now) {
        this.plans.delete(planId);
      }
    }
  }

  private evictOverflow(): void {
    while (this.plans.size > this.maxEntries) {
      const oldest = Array.from(this.plans.values()).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) return;
      this.plans.delete(oldest.planId);
    }
  }
}
