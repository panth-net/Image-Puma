import { randomUUID } from 'crypto';
import type { BatchOutputPlan, BatchOutputPlanResponse } from '../../core/shared/types';

const DEFAULT_PLAN_TTL_MS = 15 * 60 * 1000;

interface StoredDesktopPlan {
  plan: BatchOutputPlan;
  expiresAtMs: number;
}

export interface DesktopPlanStoreOptions {
  ttlMs?: number;
  now?: () => number;
  idFactory?: () => string;
}

export class DesktopPlanStore {
  private readonly ttlMs: number;

  private readonly now: () => number;

  private readonly idFactory: () => string;

  private readonly plans = new Map<string, StoredDesktopPlan>();

  constructor(options: DesktopPlanStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PLAN_TTL_MS;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  create(plan: BatchOutputPlan): BatchOutputPlanResponse {
    const createdAtMs = this.now();
    this.pruneExpired(createdAtMs);

    const planId = `desktop-plan-${this.idFactory()}`;
    const expiresAtMs = createdAtMs + this.ttlMs;
    this.plans.set(planId, { plan, expiresAtMs });

    return {
      planId,
      plan,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  resolve(planId: string): BatchOutputPlan {
    const nowMs = this.now();
    this.pruneExpired(nowMs);

    const stored = this.plans.get(planId);
    if (!stored) {
      throw new Error('PLAN_EXPIRED: Create a new preflight plan before running this batch.');
    }

    return stored.plan;
  }

  pruneExpired(nowMs = this.now()): void {
    for (const [planId, stored] of this.plans) {
      if (stored.expiresAtMs <= nowMs) {
        this.plans.delete(planId);
      }
    }
  }
}
