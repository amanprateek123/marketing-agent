import { Module } from '@nestjs/common';
import { IntelligenceSharedModule } from './shared/intelligence-shared.module';
import { SnapshotModule } from './snapshot/snapshot.module';
import { IntelligenceSchedulerModule } from './scheduler/intelligence-scheduler.module';
import { IntelligenceAdaptersModule } from './adapters/intelligence-adapters.module';
import { ObjectiveModule } from './objective/objective.module';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { TrendModule } from './trend/trend.module';
import { RevenueModule } from './revenue/revenue.module';
import { SignalModule } from './signal/signal.module';
import { DiagnosisModule } from './diagnosis/diagnosis.module';
import { BusinessModule } from './business/business.module';
import { PortfolioModule } from './portfolio/portfolio.module';
import { ForecastModule } from './forecast/forecast.module';
import { ConfidenceModule } from './confidence/confidence.module';
import { MemoryModule } from './memory/memory.module';
import { RecommendationModule } from './recommendation/recommendation.module';
import { ExplainabilityModule } from './explainability/explainability.module';
import { ExecutionModule } from './execution/execution.module';
import { LearningModule } from './learning/learning.module';
import { DecisionsModule } from './decisions/decisions.module';
import { PrimeModule } from './prime/prime.module';

/**
 * Top-level intelligence pipeline module. Every engine module is
 * @Global(); imports listed in step order (1..16).
 */
@Module({
  imports: [
    IntelligenceSharedModule,
    IntelligenceAdaptersModule,
    DecisionsModule,
    SnapshotModule.forFeature(),
    ObjectiveModule,
    LifecycleModule,
    TrendModule,
    RevenueModule,
    SignalModule,
    DiagnosisModule,
    BusinessModule,
    PortfolioModule,
    ForecastModule,
    ConfidenceModule,
    MemoryModule,
    RecommendationModule,
    ExplainabilityModule,
    ExecutionModule,
    LearningModule,
    IntelligenceSchedulerModule.forFeature(),
    PrimeModule,
  ],
})
export class IntelligenceModule {}
