/**
 * 事件投影：把不可变事件流折叠成当前业务状态。
 * 服务恢复时重放同一事件流，得到与故障前一致的状态（含待决处置与门禁依据）。
 */
export class Projection {
  constructor() {
    /** 主张：claim_id -> { claim_id, kind, versions: Map(版本 -> 版本记录), latest_version } */
    this.claims = new Map();
    /** 设计：design_id -> { design_id, versions: Map(版本 -> 版本记录), latest_version } */
    this.designs = new Map();
    /** 构件：component_id -> 构件记录 */
    this.components = new Map();
    /** 材料批次：batch_id -> 批次记录 */
    this.batches = new Map();
    /** 处置：disposition_id -> 处置记录 */
    this.dispositions = new Map();
    /** 放行历史：component_id -> [放行记录] */
    this.releases = new Map();
    /** 聚合事件序号：`${aggregate_type}:${aggregate_id}` -> 已用版本号 */
    this.aggregateSeq = new Map();
    /** 已提出处置总数，用于生成确定性的处置标识 */
    this.dispositionCount = 0;
  }

  apply(event) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "CLAIM_SUBMITTED":
        this.claims.set(event.aggregate_id, {
          claim_id: event.aggregate_id,
          kind: p.kind,
          versions: new Map([[p.version, { statement: p.statement, status: "active" }]]),
          latest_version: p.version,
        });
        break;
      case "CLAIM_CORRECTED": {
        const claim = this.claims.get(event.aggregate_id);
        claim.versions.get(p.from_version).status = "superseded";
        claim.versions.set(p.to_version, { statement: p.statement, status: "active", reason: p.reason });
        claim.latest_version = p.to_version;
        break;
      }
      case "CLAIM_RETRACTED": {
        const claim = this.claims.get(event.aggregate_id);
        claim.versions.get(p.version).status = "retracted";
        claim.versions.get(p.version).retract_reason = p.reason;
        break;
      }
      case "DESIGN_SUBMITTED": {
        let design = this.designs.get(event.aggregate_id);
        if (!design) {
          design = { design_id: event.aggregate_id, versions: new Map(), latest_version: 0 };
          this.designs.set(event.aggregate_id, design);
        }
        design.versions.set(p.version, {
          baseline_version: p.baseline_version,
          claim_refs: p.claim_refs,
          status: "submitted",
          submitted_by: p.submitted_by,
          opinions: [],
          reviews: [],
        });
        design.latest_version = p.version;
        break;
      }
      case "EXPERT_OPINION_RECORDED": {
        // 专家意见只挂到事件指定的设计版本，不随版本修订自动迁移
        this.designs.get(event.aggregate_id).versions.get(p.design_version).opinions.push({
          expert: p.expert,
          expert_role: p.expert_role,
          opinion: p.opinion,
          recorded_at: event.occurred_at,
        });
        break;
      }
      case "DESIGN_REVIEWED": {
        const version = this.designs.get(event.aggregate_id).versions.get(p.design_version);
        version.status = p.decision;
        version.reviews.push({ decision: p.decision, reviewer: p.reviewer, comment: p.comment, reviewed_at: event.occurred_at });
        break;
      }
      case "COMPONENT_REGISTERED":
        this.components.set(event.aggregate_id, {
          component_id: event.aggregate_id,
          component_type: p.component_type,
          design_id: p.design_id,
          design_version: p.design_version,
          batch_id: p.batch_id,
          stage: "designed",
          work_state: "active",
          inspections: [],
          freezes: [],
          quarantines: [],
          corrections: [],
          replaces: p.replaces ?? null,
          replaced_by: null,
        });
        if (p.replaces) this.components.get(p.replaces).replaced_by = event.aggregate_id;
        break;
      case "COMPONENT_REASSIGNED": {
        const component = this.components.get(event.aggregate_id);
        component.design_id = p.to.design_id;
        component.design_version = p.to.design_version;
        break;
      }
      case "COMPONENT_STAGE_ADVANCED": {
        const component = this.components.get(event.aggregate_id);
        component.stage = p.to_stage;
        if (p.inspection) component.inspections.push(p.inspection);
        break;
      }
      case "COMPONENT_FROZEN": {
        const component = this.components.get(event.aggregate_id);
        component.work_state = "frozen";
        component.freezes.push({ trigger: p.trigger, at: event.occurred_at });
        break;
      }
      case "COMPONENT_QUARANTINED": {
        // 已制造/安装的构件只追加隔离记录，原检验保持不变
        const component = this.components.get(event.aggregate_id);
        component.work_state = "quarantined";
        component.quarantines.push({ trigger: p.trigger, note: p.note, at: event.occurred_at });
        break;
      }
      case "COMPONENT_RESUMED":
        this.components.get(event.aggregate_id).work_state = "active";
        break;
      case "COMPONENT_CORRECTION_RECORDED": {
        const component = this.components.get(event.aggregate_id);
        component.corrections.push({ disposition_id: p.disposition_id, action: p.action, note: p.note, at: event.occurred_at });
        if (p.action === "replace") component.work_state = "replaced";
        else if (p.stage_reset_to) component.stage = p.stage_reset_to;
        break;
      }
      case "BATCH_REGISTERED":
        this.batches.set(event.aggregate_id, {
          batch_id: event.aggregate_id,
          material: p.material,
          tests: [],
          invalidated: false,
          invalidated_by: null,
        });
        break;
      case "MATERIAL_TESTED":
        this.batches.get(event.aggregate_id).tests.push({
          test_id: p.test_id,
          result: p.result,
          summary: p.summary,
          tested_at: event.occurred_at,
        });
        break;
      case "BATCH_INVALIDATED": {
        const batch = this.batches.get(event.aggregate_id);
        batch.invalidated = true;
        batch.invalidated_by = p.test_id;
        break;
      }
      case "DISPOSITION_PROPOSED":
        this.dispositionCount += 1;
        this.dispositions.set(event.aggregate_id, {
          disposition_id: event.aggregate_id,
          component_id: p.component_id,
          trigger: p.trigger,
          required_roles: p.required_roles,
          recommended_action: p.recommended_action,
          confirmations: [],
          status: "pending",
          action: null,
          proposed_at: event.occurred_at,
          resolved_at: null,
        });
        break;
      case "DISPOSITION_CONFIRMED":
        this.dispositions.get(event.aggregate_id).confirmations.push({
          role: p.role,
          decision: p.decision,
          confirmed_by: p.confirmed_by,
          note: p.note,
        });
        break;
      case "DISPOSITION_RESOLVED": {
        const disposition = this.dispositions.get(event.aggregate_id);
        disposition.status = "resolved";
        disposition.action = p.action;
        disposition.resolved_at = event.occurred_at;
        break;
      }
      case "INSTALLATION_CLEARED": {
        const records = this.releases.get(event.aggregate_id) ?? [];
        records.push({
          release_version: p.release_version,
          design_id: p.design_id,
          design_version: p.design_version,
          claim_versions: p.claim_versions,
          batch_id: p.batch_id,
          cleared_by: p.cleared_by,
          cleared_at: event.occurred_at,
        });
        this.releases.set(event.aggregate_id, records);
        break;
      }
      default:
        break;
    }
    this.aggregateSeq.set(`${event.aggregate_type}:${event.aggregate_id}`, event.version);
  }
}
