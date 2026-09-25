/** 主题雕塑创作会审使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload?: Record<string, unknown>;
}

/** 主张类别：史实证据与艺术推断分开版本化，各自拥有独立的版本链。 */
export type ClaimKind = "evidence" | "inference";

/** 主张版本状态：active 有效；superseded 已被更正版本取代；retracted 已撤回。 */
export type ClaimVersionStatus = "active" | "superseded" | "retracted";

/** 设计版本对主张的引用：明确到主张版本，并声明允许的表现范围。 */
export interface ClaimRef {
  claim_id: string;
  claim_version: number;
  representation_scope: string;
}

/** 构件加工阶段；installed 只能经安装放行门禁到达。 */
export type ComponentStage = "designed" | "in_fabrication" | "fabricated" | "installed";

/** 构件作业状态：frozen 停工（未制造完成）；quarantined 隔离（已制造/安装，只追加记录）；replaced 已替换（终态）。 */
export type WorkState = "active" | "frozen" | "quarantined" | "replaced";

/** 处置决定：继续、返工、替换。 */
export type DispositionAction = "continue" | "rework" | "replace";

/** 确认职责：史实负责人与结构负责人按触发源分别确认。 */
export type ConfirmRole = "historical_lead" | "structural_lead";

/** 处置触发源：主张更正/撤回，或材料批次失效。 */
export type DispositionTrigger =
  | { kind: "claim_corrected" | "claim_retracted"; claim_id: string; claim_version: number }
  | { kind: "batch_invalidated"; batch_id: string; test_id: string };

/** 检验记录：制造或安装时一次性写入，之后只允许追加隔离与纠正记录，不得修改。 */
export interface InspectionRecord {
  inspection_id: string;
  result: "passed";
  inspector: string;
}

/** 变更传播计算出的待决处置。 */
export interface Disposition {
  disposition_id: string;
  component_id: string;
  trigger: DispositionTrigger;
  required_roles: ConfirmRole[];
  recommended_action: DispositionAction;
  confirmations: Array<{ role: ConfirmRole; decision: DispositionAction; confirmed_by: string; note?: string }>;
  status: "pending" | "resolved";
  action: DispositionAction | null;
}

/** 安装放行记录：每次放行生成新的放行版本，反查时可看到当时采用的主张版本。 */
export interface ReleaseRecord {
  release_version: number;
  design_id: string;
  design_version: number;
  claim_versions: ClaimRef[];
  batch_id: string;
  cleared_by: string;
  cleared_at: string;
}

/** 构件反查视图：采用的主张、设计决策、材料证据与放行版本。 */
export interface ComponentTrace {
  component: {
    component_id: string;
    component_type: string;
    design_id: string;
    design_version: number;
    batch_id: string;
    stage: ComponentStage;
    work_state: WorkState;
  };
  claims: Array<ClaimRef & { kind: ClaimKind; statement: string; status: ClaimVersionStatus }>;
  design_decisions: {
    status: string;
    reviews: Array<Record<string, unknown>>;
    opinions: Array<Record<string, unknown>>;
  };
  material_evidence: { batch_id: string; material: string; invalidated: boolean; tests: Array<Record<string, unknown>> };
  inspections: InspectionRecord[];
  releases: ReleaseRecord[];
  dispositions: Disposition[];
  freezes: Array<Record<string, unknown>>;
  quarantines: Array<Record<string, unknown>>;
  corrections: Array<Record<string, unknown>>;
}
