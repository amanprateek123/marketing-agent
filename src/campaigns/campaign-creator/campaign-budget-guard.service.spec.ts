import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Model, Types, createConnection } from 'mongoose';
import {
  Company,
  CompanyDocument,
  CompanySchema,
} from '../../companies/schemas/company.schema';
import {
  Campaign,
  CampaignDocument,
  CampaignSchema,
} from '../schemas/campaign.schema';
import { CampaignBudgetGuardService } from './campaign-budget-guard.service';
import { BudgetCapError } from './safety-checks';

describe('CampaignBudgetGuardService', () => {
  let mongo: MongoMemoryServer;
  let connection: Connection;
  let companyModel: Model<CompanyDocument>;
  let campaignModel: Model<CampaignDocument>;
  let firstInstance: CampaignBudgetGuardService;
  let secondInstance: CampaignBudgetGuardService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    connection = await createConnection(mongo.getUri()).asPromise();
    companyModel = connection.model(
      Company.name,
      CompanySchema,
    ) as unknown as Model<CompanyDocument>;
    campaignModel = connection.model(
      Campaign.name,
      CampaignSchema,
    ) as unknown as Model<CampaignDocument>;
    // Separate service instances sharing only Mongo simulate separate app
    // processes; passing this test cannot depend on a JavaScript mutex.
    firstInstance = new CampaignBudgetGuardService(companyModel, campaignModel);
    secondInstance = new CampaignBudgetGuardService(
      companyModel,
      campaignModel,
    );
  });

  afterAll(async () => {
    await connection?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      companyModel.deleteMany({}),
      campaignModel.deleteMany({}),
    ]);
  });

  async function insertCompany(tenantId: string, weeklyBudgetCap: number) {
    await companyModel.collection.insertOne({
      tenantId,
      weeklyBudgetCap,
      campaignBudgetGuardVersion: 0,
      campaignBudgetReservations: [],
    });
  }

  async function insertCampaign(input: {
    tenantId: string;
    budget: number;
    status: 'pending_approval' | 'launching' | 'active';
    source?: 'agent' | 'human' | 'manual';
  }): Promise<string> {
    const _id = new Types.ObjectId();
    await campaignModel.collection.insertOne({
      _id,
      tenantId: input.tenantId,
      budget: input.budget,
      status: input.status,
      source: input.source ?? 'agent',
      objective: 'OUTCOME_SALES',
      metaCampaignId: '',
    });
    return _id.toString();
  }

  it('atomically allows only one over-cap concurrent reservation across service instances', async () => {
    await insertCompany('tenant-a', 7_000);
    const firstCampaignId = await insertCampaign({
      tenantId: 'tenant-a',
      budget: 1_000,
      status: 'pending_approval',
    });
    const secondCampaignId = await insertCampaign({
      tenantId: 'tenant-a',
      budget: 1_000,
      status: 'pending_approval',
    });

    const outcomes = await Promise.allSettled([
      firstInstance.reserve('tenant-a', firstCampaignId, 1_000),
      secondInstance.reserve('tenant-a', secondCampaignId, 1_000),
    ]);

    expect(
      outcomes.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = outcomes.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(BudgetCapError);

    const company = await companyModel
      .findOne({ tenantId: 'tenant-a' })
      .select('campaignBudgetReservations')
      .lean()
      .exec();
    expect((company as any).campaignBudgetReservations).toHaveLength(1);
  });

  it('hands reservation capacity to launching status without a sequential gap', async () => {
    await insertCompany('tenant-a', 7_000);
    const firstCampaignId = await insertCampaign({
      tenantId: 'tenant-a',
      budget: 600,
      status: 'pending_approval',
    });
    const secondCampaignId = await insertCampaign({
      tenantId: 'tenant-a',
      budget: 500,
      status: 'pending_approval',
    });

    const reservation = await firstInstance.reserve(
      'tenant-a',
      firstCampaignId,
      600,
    );
    await campaignModel.updateOne(
      {
        tenantId: 'tenant-a',
        _id: firstCampaignId,
        status: 'pending_approval',
      },
      { $set: { status: 'launching' } },
    );
    await firstInstance.release(reservation);

    await expect(
      secondInstance.reserve('tenant-a', secondCampaignId, 500),
    ).rejects.toBeInstanceOf(BudgetCapError);
  });

  it('releases a failed claim reservation while ignoring imported Meta campaigns', async () => {
    await insertCompany('tenant-a', 7_000);
    await insertCampaign({
      tenantId: 'tenant-a',
      budget: 10_000,
      status: 'active',
      source: 'manual',
    });
    const firstCampaignId = await insertCampaign({
      tenantId: 'tenant-a',
      budget: 1_000,
      status: 'pending_approval',
    });
    const secondCampaignId = await insertCampaign({
      tenantId: 'tenant-a',
      budget: 1_000,
      status: 'pending_approval',
    });

    const reservation = await firstInstance.reserve(
      'tenant-a',
      firstCampaignId,
      1_000,
    );
    expect(await firstInstance.release(reservation)).toBe(true);
    expect(await firstInstance.release(reservation)).toBe(false);

    await expect(
      secondInstance.reserve('tenant-a', secondCampaignId, 1_000),
    ).resolves.toMatchObject({
      tenantId: 'tenant-a',
      campaignId: secondCampaignId,
      weeklyAmount: 7_000,
    });
  });
});
