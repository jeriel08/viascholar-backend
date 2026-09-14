import { Injectable, Logger } from '@nestjs/common';
import { SelectSchoolDto } from './dto/select-school.dto.js';
import { BatchUpdateSubjectsDto } from './dto/batch-update-subjects.dto.js';
import { FreezeBaselineDto } from './dto/freeze-baseline.dto.js';
import { ScholarBaselineService } from './services/scholar-baseline.service.js';
import { BaselineDocumentIngestionService } from './services/baseline-document-ingestion.service.js';
import { CoordinatorBaselineService } from './services/coordinator-baseline.service.js';
import { ActiveScholarsAnalyticsService } from './services/active-scholars-analytics.service.js';

@Injectable()
export class AcademicBaselineService {
  private readonly logger = new Logger(AcademicBaselineService.name);

  constructor(
    private readonly scholarBaselineService: ScholarBaselineService,
    private readonly baselineDocumentIngestionService: BaselineDocumentIngestionService,
    private readonly coordinatorBaselineService: CoordinatorBaselineService,
    private readonly activeScholarsAnalyticsService: ActiveScholarsAnalyticsService,
  ) {}

  // ==========================================
  // SCHOLAR ONBOARDING BASELINE OPERATIONS
  // ==========================================

  // 1. Get complete baseline onboarding state for current scholar
  async getScholarBaselineState(userId: number) {
    return this.scholarBaselineService.getScholarBaselineState(userId);
  }

  // 2. Scholar selects or proposes school grading system
  async selectOrProposeSchool(userId: number, dto: SelectSchoolDto) {
    return this.scholarBaselineService.selectOrProposeSchool(userId, dto);
  }

  // 3. Upload Prospectus Document & Trigger Batch Ingestion OCR
  async uploadProspectus(userId: number, files: Express.Multer.File[]) {
    return this.baselineDocumentIngestionService.uploadProspectus(userId, files);
  }

  // 4. Scholar / Staff updates prospectus subjects before freezing
  async updateProspectusSubjects(
    userId: number,
    dto: BatchUpdateSubjectsDto,
    isStaff = false,
  ) {
    return this.scholarBaselineService.updateProspectusSubjects(userId, dto, isStaff);
  }

  // 5. Upload Historical CCG / TOR & Auto-Credit Passed Courses
  async uploadHistoricalCcg(userId: number, files: Express.Multer.File[]) {
    return this.baselineDocumentIngestionService.uploadHistoricalCcg(userId, files);
  }

  // 6. Scholar submits baseline for coordinator freeze review
  async submitForReview(userId: number) {
    return this.scholarBaselineService.submitForReview(userId);
  }

  // ==========================================
  // COORDINATOR AUDIT & GOVERNANCE OPERATIONS
  // ==========================================

  // 7. Coordinator: Get all scholars awaiting baseline review / frozen status
  async getCoordinatorPendingBaselines() {
    return this.coordinatorBaselineService.getCoordinatorPendingBaselines();
  }

  // 8. Coordinator: Get full side-by-side audit bundle for a scholar
  async getCoordinatorBaselineReview(scholarProfileId: number) {
    return this.coordinatorBaselineService.getCoordinatorBaselineReview(scholarProfileId);
  }

  // 9. Coordinator updates / adds / adjusts subjects on a prospectus
  async coordinatorUpdateSubjects(
    employeeUserId: number,
    prospectusId: number,
    dto: BatchUpdateSubjectsDto,
  ) {
    return this.coordinatorBaselineService.coordinatorUpdateSubjects(
      employeeUserId,
      prospectusId,
      dto,
    );
  }

  // 10. Coordinator: Freeze Baseline (Locks curriculum from further changes)
  async freezeBaseline(
    employeeUserId: number,
    prospectusId: number,
    dto: FreezeBaselineDto,
  ) {
    return this.coordinatorBaselineService.freezeBaseline(
      employeeUserId,
      prospectusId,
      dto,
    );
  }

  // 11. Coordinator: Unfreeze Baseline (Unlocks if manual revision needed)
  async unfreezeBaseline(employeeUserId: number, prospectusId: number) {
    return this.coordinatorBaselineService.unfreezeBaseline(
      employeeUserId,
      prospectusId,
    );
  }

  // ==========================================
  // ACTIVE SCHOLARS REAL-TIME ANALYTICS
  // ==========================================

  // 12. Coordinator: Get all active scholars with real-time academic standing & financial summary
  async getCoordinatorActiveScholars() {
    return this.activeScholarsAnalyticsService.getCoordinatorActiveScholars();
  }
}
