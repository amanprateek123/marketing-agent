import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Company,
  CompanyDocument,
} from '../../companies/schemas/company.schema';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { BudgetCapError } from './safety-checks';

export interface CampaignBudgetReservation {
  token: string;
  tenantId: string;
  campaignId: string;
  weeklyAmount: number;
}

interface StoredBudgetReservation {
  token: string;
  campaignId: string;
  weeklyAmount: number;
  createdAt: Date;
}

interface WeeklyCommitment {
  total: number;
  campaignIds: Set<string>;
}

/**
 * Cross-instance weekly-budget gate for campaign approval.
 *
 * MongoDB transactions are deliberately not required: the production Docker
 * deployment uses a standalone Mongo server. Instead, a temporary reservation
 * is appended to the tenant's Company document with a versioned CAS. The
 * reservation is only released after the Campaign has atomically become
 * `launching`, which then becomes the durable weekly commitment.
 */
@Injectable()
export class CampaignBudgetGuardService {
  private readonly logger = new Logger(CampaignBudgetGuardService.name);
  private static readonly MAX_CAS_ATTEMPTS = 12;

  constructor(
    @InjectModel(Company.name)
    private readonly companyModel: Model<CompanyDocument>,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
  ) {}

  /**
   * Reserve one campaign's seven-day run-rate before claiming it for launch.
   * Every query is tenant-scoped. A CAS miss means another app instance changed
   * the guard while this instance was reading campaign commitments, so the
   * whole calculation is retried from fresh Mongo state.
   */
  async reserve(
    tenantId: string,
    campaignId: string,
    dailyBudget: number,
  ): Promise<CampaignBudgetReservation> {
    const normalizedDailyBudget = Number(dailyBudget);
    if (!Number.isFinite(normalizedDailyBudget) || normalizedDailyBudget <= 0) {
      throw new BudgetCapError(
        `Campaign budget must be a positive finite daily amount. Got: ${dailyBudget}`,
      );
    }

    const weeklyAmount = normalizedDailyBudget * 7;

    for (
      let attempt = 1;
      attempt <= CampaignBudgetGuardService.MAX_CAS_ATTEMPTS;
      attempt++
    ) {
      const company = await this.companyModel
        .findOne({ tenantId })
        .select(
          'tenantId weeklyBudgetCap campaignBudgetGuardVersion campaignBudgetReservations',
        )
        .lean()
        .exec();
      if (!company) {
        throw new Error(`Company "${tenantId}" not found`);
      }

      const guardVersion = Number(
        (company as any).campaignBudgetGuardVersion ?? 0,
      );
      const weeklyCap = Number((company as any).weeklyBudgetCap ?? 0);
      const reservations = this.normalizeReservations(
        (company as any).campaignBudgetReservations,
      );

      if (reservations.some((r) => r.campaignId === campaignId)) {
        throw new Error(
          `Campaign ${campaignId} already has a budget reservation; approval is already in progress or requires reconciliation.`,
        );
      }

      const committed = await this.getWeeklyCommitment(tenantId);
      // During the handoff, a campaign can briefly exist in both places. Count
      // it once, not twice: `launching` is already the durable commitment.
      const unmatchedReserved = reservations.reduce(
        (sum, reservation) =>
          committed.campaignIds.has(reservation.campaignId)
            ? sum
            : sum + reservation.weeklyAmount,
        0,
      );
      const projectedTotal = committed.total + unmatchedReserved + weeklyAmount;

      if (projectedTotal > weeklyCap) {
        throw new BudgetCapError(
          `Weekly budget cap reached: ₹${committed.total + unmatchedReserved} already committed/reserved + ₹${weeklyAmount} projected (₹${normalizedDailyBudget}/day × 7) > ₹${weeklyCap} cap`,
        );
      }

      const token = randomUUID();
      const reservation: StoredBudgetReservation = {
        token,
        campaignId,
        weeklyAmount,
        createdAt: new Date(),
      };

      const updated = await this.companyModel
        .findOneAndUpdate(
          {
            tenantId,
            weeklyBudgetCap: weeklyCap,
            $expr: {
              $eq: [
                { $ifNull: ['$campaignBudgetGuardVersion', 0] },
                guardVersion,
              ],
            },
            campaignBudgetReservations: {
              $not: { $elemMatch: { campaignId } },
            },
          },
          {
            $push: { campaignBudgetReservations: reservation },
            $inc: { campaignBudgetGuardVersion: 1 },
          },
          { returnDocument: 'after' },
        )
        .select('_id')
        .lean()
        .exec();

      if (updated) {
        this.logger.log(
          `Weekly budget reserved: tenant=${tenantId} campaign=${campaignId} amount=₹${weeklyAmount} token=${token}`,
        );
        return { token, tenantId, campaignId, weeklyAmount };
      }

      // A competing reservation/release or cap edit won the CAS. Re-read both
      // Company and Campaign collections before making another decision.
    }

    throw new Error(
      `Could not reserve weekly budget for campaign ${campaignId} after ${CampaignBudgetGuardService.MAX_CAS_ATTEMPTS} concurrent updates; retry approval.`,
    );
  }

  /**
   * Remove exactly this approval's reservation. Idempotent when it is already
   * gone; callers can safely retry after an uncertain response.
   */
  async release(reservation: CampaignBudgetReservation): Promise<boolean> {
    const updated = await this.companyModel
      .findOneAndUpdate(
        {
          tenantId: reservation.tenantId,
          campaignBudgetReservations: {
            $elemMatch: {
              token: reservation.token,
              campaignId: reservation.campaignId,
            },
          },
        },
        {
          $pull: {
            campaignBudgetReservations: {
              token: reservation.token,
              campaignId: reservation.campaignId,
            },
          },
          $inc: { campaignBudgetGuardVersion: 1 },
        },
        { returnDocument: 'after' },
      )
      .select('_id')
      .lean()
      .exec();

    if (updated) {
      this.logger.log(
        `Weekly budget reservation released: tenant=${reservation.tenantId} campaign=${reservation.campaignId} token=${reservation.token}`,
      );
      return true;
    }

    const company = await this.companyModel
      .findOne({ tenantId: reservation.tenantId })
      .select('campaignBudgetReservations')
      .lean()
      .exec();
    if (!company) {
      throw new Error(`Company "${reservation.tenantId}" not found`);
    }

    const stillPresent = this.normalizeReservations(
      (company as any).campaignBudgetReservations,
    ).some(
      (candidate) =>
        candidate.token === reservation.token &&
        candidate.campaignId === reservation.campaignId,
    );
    if (stillPresent) {
      throw new Error(
        `Failed to release weekly budget reservation ${reservation.token} for campaign ${reservation.campaignId}`,
      );
    }
    return false;
  }

  /** Planned seven-day run-rate for campaigns capable of spending now. */
  async getWeeklyCommitment(tenantId: string): Promise<WeeklyCommitment> {
    const campaigns = await this.campaignModel
      .find({
        tenantId,
        source: { $in: ['agent', 'human'] },
        status: { $in: ['active', 'launching'] },
      })
      .select('_id budget')
      .lean()
      .exec();

    const campaignIds = new Set<string>();
    let total = 0;
    for (const campaign of campaigns) {
      const budget = Number((campaign as any).budget ?? 0);
      if (!Number.isFinite(budget) || budget <= 0) continue;
      campaignIds.add(String((campaign as any)._id));
      total += budget * 7;
    }
    return { total, campaignIds };
  }

  private normalizeReservations(value: unknown): StoredBudgetReservation[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry: any) => ({
        token: String(entry?.token ?? ''),
        campaignId: String(entry?.campaignId ?? ''),
        weeklyAmount: Number(entry?.weeklyAmount ?? 0),
        createdAt: new Date(entry?.createdAt ?? 0),
      }))
      .filter(
        (entry) =>
          entry.token &&
          entry.campaignId &&
          Number.isFinite(entry.weeklyAmount) &&
          entry.weeklyAmount > 0,
      );
  }
}
