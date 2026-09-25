/** 主题雕塑创作会审：主张到构件变更传播链的领域类型。 */

// ---------- 枚举与基础 ----------

/** 主张性质：史实证据与艺术推断分开版本化，互不混同。 */
export type ClaimKind = "historical_evidence" | "artistic_inference";

/** 主张版本状态。分叉时旧版本仍可作为另一分支头部保持 active。 */
export type ClaimVersionStatus = "active" | "superseded" | "withdrawn";

export type ClaimStatus = "active" | "withdrawn";

/** 更正方式：revise 直接取代旧版；fork 从旧版分叉出并行解释分支。 */
export type CorrectionMode = "revise" | "fork";

/** 构件专业：艺术构件（浮雕、铭牌）受史实主张约束；底座等结构构件不引用主张。 */
export type Discipline = "art" | "structure";

export type ComponentStatus =
  | "registered"
  | "in_production"
  | "manufactured"
  | "installed"
  | "reworking"
  | "replaced";

/** 处置选项。 */
export type DispositionDecision = "continue" | "rework" | "replace";

export type HoldSourceType = "claim" | "batch";

export type ReleaseKind = "installation" | "label";

// ---------- 事件信封 ----------

export interface DomainEvent {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  /** 聚合内单调递增版本。 */
  version: number;
  summary: string;
  payload?: EventPayload;
}

export type AggregateType =
  | "historical_claim"
  | "expert_opinion"
  | "design_version"
  | "component"
  | "fabrication_batch"
  | "propagation_hold"
  | "installation_release"
  | "idempotency_record";

export type DomainEventType =
  // 主张与意见
  | "CLAIM_SUBMITTED"
  | "CLAIM_CORRECTED"
  | "CLAIM_WITHDRAWN"
  | "EXPERT_OPINION_RECORDED"
  // 设计
  | "DESIGN_SUBMITTED"
  | "DESIGN_DECISION_RECORDED"
  // 构件与加工
  | "COMPONENT_REGISTERED"
  | "COMPONENT_FROZEN"
  | "COMPONENT_UNFROZEN"
  | "WORK_ORDER_ISSUED"
  | "INSPECTION_RECORDED"
  | "QUARANTINE_RECORDED"
  | "CORRECTIVE_ACTION_RECORDED"
  | "COMPONENT_REWORK_STARTED"
  | "COMPONENT_REPLACED"
  // 材料批次
  | "BATCH_REGISTERED"
  | "COMPONENT_ASSIGNED_BATCH"
  | "MATERIAL_TEST_RECORDED"
  | "BATCH_QUARANTINED"
  // 变更传播处置
  | "PROPAGATION_HOLD_OPENED"
  | "DISPOSITION_CONFIRMED"
  | "HOLD_RESOLVED"
  // 放行门禁
  | "RELEASE_REJECTED"
  | "INSTALLATION_CLEARED"
  | "LABEL_RELEASED"
  // 命令幂等存根
  | "IDEMPOTENCY_RECORDED";

export type EventPayload = Record<string, unknown>;

// ---------- 读模型（由事件重放得到） ----------

export interface ClaimVersion {
  version: number;
  statement: string;
  status: ClaimVersionStatus;
  reason?: string;
  /** 分叉或修订的父版本，用于呈现主张谱系。 */
  parent_version: number | null;
  fork: boolean;
}

export interface ClaimState {
  id: string;
  kind: ClaimKind;
  subject: string;
  status: ClaimStatus;
  current_version: number;
  versions: ClaimVersion[];
}

export interface ExpertOpinionState {
  id: string;
  claim_id: string;
  /** 意见只作用于这一主张版本。 */
  claim_version: number;
  expert: string;
  conclusion: string;
}

export interface ClaimCitation {
  claim_id: string;
  claim_version: number;
}

/** 允许的表现范围：越界刻画在门禁处被拒绝。 */
export interface DepictionRange {
  permitted: string[];
  prohibited: string[];
}

export interface DesignVersionState {
  version: number;
  citations: ClaimCitation[];
  allowed_depiction: DepictionRange;
  /** 策展文字/浮雕方案等内容指纹；内容变化即产生新版本。 */
  content_text: string;
  content_hash: string;
  /** 采纳的专家意见，必须全部落在引用版本范围内。 */
  opinion_ids: string[];
  submitted_at: string;
}

export interface DesignState {
  id: string;
  component_id: string;
  current_version: number;
  versions: DesignVersionState[];
}

export interface InspectionRecord {
  inspection_id: string;
  stage: "material" | "final";
  result: "pass" | "fail";
  note: string;
  recorded_at: string;
}

export interface QuarantineRecord {
  record_id: string;
  reason: string;
  source_hold_id?: string;
  recorded_at: string;
}

export interface CorrectiveRecord {
  record_id: string;
  action: string;
  recorded_by: string;
  recorded_at: string;
}

export interface ComponentState {
  id: string;
  name: string;
  discipline: Discipline;
  design_id: string | null;
  /** 当前执行的设计版本（工单下发时快照）。 */
  design_version: number | null;
  batch_id: string | null;
  status: ComponentStatus;
  frozen: boolean;
  /** 仅追加：原检验永远不可修改。 */
  inspections: InspectionRecord[];
  quarantines: QuarantineRecord[];
  corrections: CorrectiveRecord[];
}

export interface MaterialTestRecord {
  test_id: string;
  test_type: string;
  result: "pass" | "fail";
  report_ref: string;
  recorded_at: string;
}

export interface BatchState {
  id: string;
  material: string;
  quarantined: boolean;
  component_ids: string[];
  tests: MaterialTestRecord[];
}

/** 单个构件、单一来源的处置单：主张更正需史实+结构双签，材料失效只需结构签认。 */
export interface HoldState {
  id: string;
  component_id: string;
  source_type: HoldSourceType;
  claim_id?: string;
  from_version?: number;
  to_version?: number;
  batch_id?: string;
  test_id?: string;
  reason: string;
  status: "open" | "resolved";
  outcome?: DispositionDecision;
  required_roles: string[];
  confirmations: Array<{
    role: string;
    decision: DispositionDecision;
    decided_by: string;
    new_design_version?: number;
    note?: string;
    confirmed_at: string;
  }>;
  opened_at: string;
  resolved_at?: string;
}

export interface ReleaseState {
  kind: ReleaseKind;
  version: number;
  released_at: string;
  gate_snapshot: GateSnapshot;
}

export interface GateSnapshot {
  component_id: string;
  design_id: string;
  design_version: number;
  design_content_hash: string;
  citations: ClaimCitation[];
  batch_id: string | null;
  batch_test_ids: string[];
  final_inspection_id: string | null;
  hold_ids: string[];
}

export interface GateViolation {
  code: string;
  message: string;
}
