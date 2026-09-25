import {
  BaselineConflictError,
  ConflictError,
  DomainError,
  GateBlockedError,
  NotFoundError,
  OpinionScopeError,
  ReplayConflictError,
} from "./errors.js";
import { contentHash } from "./hashing.js";

const HISTORICAL_LEAD = "historical_lead";
const STRUCTURAL_LEAD = "structural_lead";

/**
 * 主张到构件的变更传播服务。
 *
 * 所有状态变更都以追加事件落盘，读模型由事件重放得到：
 * 重启服务后待决处置单、构件冻结状态与放行门禁自动恢复。
 */
export class PropagationService {
  constructor(store, clock = () => new Date().toISOString()) {
    this.store = store;
    this.now = clock;
    this.claims = new Map();
    this.opinions = new Map();
    this.designs = new Map();
    this.components = new Map();
    this.batches = new Map();
    this.holds = new Map();
    /** component_id -> 历次放行（含安装与铭牌），旧版本保留不覆盖。 */
    this.releases = new Map();
    this.rejections = new Map();
    this.idempotency = new Map();
    this.versions = new Map();
    this.seq = 0;

    for (const event of this.store.load()) this._apply(event);
  }

  // ---------- 基础设施 ----------

  _nextId() {
    this.seq += 1;
    return `evt-${String(this.seq).padStart(6, "0")}`;
  }

  _emit(eventType, aggregateType, aggregateId, summary, payload = {}) {
    const key = `${aggregateType}:${aggregateId}`;
    const version = (this.versions.get(key) ?? 0) + 1;
    const event = {
      event_id: this._nextId(),
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.now(),
      version,
      summary,
      payload,
    };
    this.store.append(event);
    this._apply(event);
    return event;
  }

  /**
   * 命令幂等：同一键重传直接返回首次结果；
   * 键相同但请求内容指纹不同，判定为重放并拒绝。
   * 首次被业务拒绝（如门禁阻断）也留存错误指纹：审批重传得到同一结论，
   * 服务重启后幂等记录随事件日志一并恢复。
   */
  _withIdempotency(key, request, fn) {
    if (!key) return fn();
    const existing = this.idempotency.get(key);
    const hash = contentHash(request);
    if (existing) {
      if (existing.request_hash !== hash) {
        throw new ReplayConflictError(key, existing.request_hash, hash);
      }
      if (existing.error) {
        if (existing.error.code === "GATE_BLOCKED") {
          throw new GateBlockedError(existing.error.details?.violations ?? []);
        }
        throw new DomainError(existing.error.code, existing.error.message, existing.error.details ?? {});
      }
      return existing.result;
    }
    let result;
    let error = null;
    try {
      result = fn();
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      // 仅门禁拒绝需要失败幂等（审批重传得同一结论并留痕）；
      // 其余客户端错误（基线冲突、越权、校验失败）不占用幂等键，调用方修正后可重试。
      if (e.code !== "GATE_BLOCKED") throw e;
      error = { code: e.code, message: e.message, details: e.details ?? {} };
    }
    this._emit("IDEMPOTENCY_RECORDED", "idempotency_record", key, "命令幂等存根", {
      command: request.command,
      request_hash: hash,
      result: result ?? null,
      error,
    });
    if (error) {
      if (error.code === "GATE_BLOCKED") throw new GateBlockedError(error.details.violations ?? []);
      throw new DomainError(error.code, error.message, error.details);
    }
    return result;
  }

  _getClaim(id) {
    const claim = this.claims.get(id);
    if (!claim) throw new NotFoundError("史实主张", id);
    return claim;
  }

  _getComponent(id) {
    const comp = this.components.get(id);
    if (!comp) throw new NotFoundError("构件", id);
    return comp;
  }

  _getDesign(id) {
    const design = this.designs.get(id);
    if (!design) throw new NotFoundError("设计版本", id);
    return design;
  }

  _getBatch(id) {
    const batch = this.batches.get(id);
    if (!batch) throw new NotFoundError("材料批次", id);
    return batch;
  }

  _getHold(id) {
    const hold = this.holds.get(id);
    if (!hold) throw new NotFoundError("变更处置单", id);
    return hold;
  }

  // ---------- 主张：史实证据与艺术推断分开版本化 ----------

  submitClaim(cmd) {
    const { claim_id, kind, subject, statement, idempotency_key: key } = cmd;
    if (kind !== "historical_evidence" && kind !== "artistic_inference") {
      throw new DomainError("INVALID_KIND", "主张性质必须是 historical_evidence 或 artistic_inference", { kind });
    }
    return this._withIdempotency(
      key,
      { command: "submitClaim", claim_id, kind, subject, statement },
      () => {
        if (this.claims.has(claim_id)) throw new ConflictError("主张已存在", { claim_id });
        this._emit("CLAIM_SUBMITTED", "historical_claim", claim_id, `登记主张：${subject}`, {
          kind,
          subject,
          statement,
        });
        return { claim_id, version: 1 };
      },
    );
  }

  /**
   * 更正主张。revise：新版取代旧版；fork：旧版保留为并行解释分支。
   * 更正后立即计算受影响构件并开出处置单、局部停工。
   */
  correctClaim(cmd) {
    const { claim_id, new_statement, reason, mode = "revise", idempotency_key: key } = cmd;
    const claim = this._getClaim(claim_id);
    if (claim.status !== "active") throw new ConflictError("主张已撤回，不能再更正", { claim_id });
    const fromVersion = claim.current_version;
    const newVersion = Math.max(...claim.versions.map((v) => v.version)) + 1;
    return this._withIdempotency(
      key,
      { command: "correctClaim", claim_id, new_statement, reason, mode },
      () => {
        this._emit("CLAIM_CORRECTED", "historical_claim", claim_id, `主张更正 v${newVersion}`, {
          mode,
          from_version: fromVersion,
          new_version: newVersion,
          new_statement,
          reason,
        });
        // 分叉（fork）：旧版本作为并行解释分支仍然有效，引用它的构件照常施工，
        // 是否迁移到新分支由后续设计提交决定；只有修订取代（revise）才触发停工处置。
        const holdIds =
          mode === "fork" ? [] : this._propagateClaimChange(claim_id, fromVersion, newVersion, reason ?? "主张更正");
        return { claim_id, from_version: fromVersion, new_version: newVersion, hold_ids: holdIds };
      },
    );
  }

  withdrawClaim(cmd) {
    const { claim_id, reason, idempotency_key: key } = cmd;
    const claim = this._getClaim(claim_id);
    if (claim.status !== "active") throw new ConflictError("主张已处于撤回状态", { claim_id });
    const version = claim.current_version;
    return this._withIdempotency(
      key,
      { command: "withdrawClaim", claim_id, reason },
      () => {
        this._emit("CLAIM_WITHDRAWN", "historical_claim", claim_id, "主张撤回", {
          version,
          reason,
        });
        const holdIds = this._propagateClaimChange(claim_id, version, null, reason ?? "主张撤回");
        return { claim_id, withdrawn_version: version, hold_ids: holdIds };
      },
    );
  }

  // ---------- 专家意见：绑定单一主张版本 ----------

  recordOpinion(cmd) {
    const { opinion_id, claim_id, claim_version, expert, conclusion } = cmd;
    const claim = this._getClaim(claim_id);
    if (!claim.versions.some((v) => v.version === claim_version)) {
      throw new NotFoundError(`主张 ${claim_id} 的版本`, claim_version);
    }
    if (this.opinions.has(opinion_id)) throw new ConflictError("专家意见已存在", { opinion_id });
    this._emit("EXPERT_OPINION_RECORDED", "expert_opinion", opinion_id, `${expert} 的专家意见`, {
      claim_id,
      claim_version,
      expert,
      conclusion,
    });
    return { opinion_id, claim_id, claim_version };
  }

  // ---------- 设计版本：明确引用的主张与允许的表现范围 ----------

  submitDesign(cmd) {
    const {
      design_id,
      component_id,
      citations,
      allowed_depiction: depiction,
      content_text: text,
      opinion_ids: opinionIds = [],
      expected_version: expected = 0,
      idempotency_key: key,
    } = cmd;
    const component = this._getComponent(component_id);
    const existing = this.designs.get(design_id);
    if (expected === 0) {
      if (existing) throw new ConflictError("设计已存在，并行提交须携带 expected_version", { design_id });
    } else {
      if (!existing) throw new NotFoundError("设计版本", design_id);
      if (existing.current_version !== expected) {
        throw new BaselineConflictError(expected, existing.current_version);
      }
    }

    const citationMap = new Map();
    for (const c of citations) {
      const claim = this._getClaim(c.claim_id);
      if (!claim.versions.some((v) => v.version === c.claim_version)) {
        throw new NotFoundError(`主张 ${c.claim_id} 的版本`, c.claim_version);
      }
      citationMap.set(c.claim_id, c.claim_version);
    }
    // 专家意见只能作用于其绑定的主张版本：引用的意见必须与设计引用的版本严格一致。
    for (const opinionId of opinionIds) {
      const opinion = this.opinions.get(opinionId);
      if (!opinion) throw new NotFoundError("专家意见", opinionId);
      if (citationMap.get(opinion.claim_id) !== opinion.claim_version) {
        throw new OpinionScopeError(opinionId, `${opinion.claim_id}@v${opinion.claim_version}`, [
          ...citationMap.entries()
        ]);
      }
    }

    const hash = contentHash(text);
    const newVersion = expected + 1;
    return this._withIdempotency(
      key,
      { command: "submitDesign", design_id, citations, depiction, text, opinionIds, expected },
      () => {
        this._emit("DESIGN_SUBMITTED", "design_version", design_id, `设计提交 v${newVersion}`, {
          component_id,
          version: newVersion,
          baseline_version: expected,
          citations: citations.map((c) => ({ ...c })),
          allowed_depiction: {
            permitted: depiction.permitted.slice(),
            prohibited: depiction.prohibited.slice(),
          },
          content_text: text,
          content_hash: hash,
          opinion_ids: opinionIds.slice(),
        });
        return { design_id, component_id, version: newVersion, content_hash: hash };
      },
    );
  }

  recordDesignDecision(cmd) {
    const { design_id, decision_id, decision, decided_by, idempotency_key: key } = cmd;
    this._getDesign(design_id);
    return this._withIdempotency(
      key,
      { command: "recordDesignDecision", design_id, decision_id, decision, decided_by },
      () => {
        this._emit("DESIGN_DECISION_RECORDED", "design_version", design_id, `设计决策：${decision_id}`, {
          decision_id,
          decision,
          decided_by,
        });
        return { decision_id };
      },
    );
  }

  // ---------- 构件与加工 ----------

  registerComponent(cmd) {
    const { component_id, name, discipline } = cmd;
    if (discipline !== "art" && discipline !== "structure") {
      throw new DomainError("INVALID_DISCIPLINE", "构件专业必须是 art 或 structure", { discipline });
    }
    if (this.components.has(component_id)) throw new ConflictError("构件已存在", { component_id });
    this._emit("COMPONENT_REGISTERED", "component", component_id, `登记构件：${name}`, {
      name,
      discipline,
    });
    return { component_id };
  }

  issueWorkOrder(cmd) {
    const { component_id, idempotency_key: key } = cmd;
    const comp = this._getComponent(component_id);
    return this._withIdempotency(key, { command: "issueWorkOrder", component_id }, () => {
      if (comp.frozen) throw new ConflictError("构件处于停工冻结，不能下发工单", { component_id });
      if (!["registered", "reworking"].includes(comp.status)) {
        throw new ConflictError("当前状态不能下发工单", { component_id, status: comp.status });
      }
      const design = this._getDesign(comp.design_id);
      const dv = design.versions.find((v) => v.version === design.current_version);
      if (comp.batch_id && this._getBatch(comp.batch_id).quarantined) {
        throw new ConflictError("绑定批次已隔离，不能下发工单", { component_id, batch_id: comp.batch_id });
      }
      this._emit("WORK_ORDER_ISSUED", "component", component_id, `按设计 v${dv.version} 下发加工工单`, {
        design_id: design.id,
        design_version: dv.version,
        content_hash: dv.content_hash,
      });
      return { component_id, design_id: design.id, design_version: dv.version };
    });
  }

  /** 检验记录只追加：任何处置都不能修改或删除原检验。 */
  recordInspection(cmd) {
    const { component_id, inspection_id, stage, result, note } = cmd;
    const comp = this._getComponent(component_id);
    if (comp.inspections.some((i) => i.inspection_id === inspection_id)) {
      throw new ConflictError("检验记录已存在且不可修改", { inspection_id });
    }
    if (!["material", "final"].includes(stage)) throw new ConflictError("未知检验阶段", { stage });
    if (!["pass", "fail"].includes(result)) throw new ConflictError("检验结果必须是 pass 或 fail", { result });
    this._emit("INSPECTION_RECORDED", "component", component_id, `检验记录 ${inspection_id}（${result}）`, {
      inspection_id,
      stage,
      result,
      note,
    });
    return { inspection_id };
  }

  // ---------- 材料批次与试验 ----------

  registerBatch(cmd) {
    const { batch_id, material } = cmd;
    if (this.batches.has(batch_id)) throw new ConflictError("批次已存在", { batch_id });
    this._emit("BATCH_REGISTERED", "fabrication_batch", batch_id, `登记材料批次：${material}`, {
      material,
    });
    return { batch_id };
  }

  assignBatch(cmd) {
    const { component_id, batch_id } = cmd;
    const comp = this._getComponent(component_id);
    const batch = this._getBatch(batch_id);
    if (batch.quarantined) throw new ConflictError("批次已隔离，不能再绑定构件", { batch_id });
    if (comp.batch_id === batch_id) return { component_id, batch_id };
    this._emit("COMPONENT_ASSIGNED_BATCH", "component", component_id, `绑定材料批次 ${batch_id}`, {
      batch_id,
    });
    return { component_id, batch_id };
  }

  /**
   * 材料试验失效：批次立即隔离，并沿批次关联传播到全部在用构件。
   */
  recordMaterialTest(cmd) {
    const { batch_id, test_id, test_type, result, report_ref, idempotency_key: key } = cmd;
    const batch = this._getBatch(batch_id);
    return this._withIdempotency(
      key,
      { command: "recordMaterialTest", batch_id, test_id, test_type, result, report_ref },
      () => {
        if (batch.tests.some((t) => t.test_id === test_id)) {
          throw new ConflictError("试验记录已存在且不可修改", { test_id });
        }
        if (!["pass", "fail"].includes(result)) {
          throw new ConflictError("试验结果必须是 pass 或 fail", { result });
        }
        this._emit("MATERIAL_TEST_RECORDED", "fabrication_batch", batch_id, `材料试验 ${test_id}（${result}）`, {
          test_id,
          test_type,
          result,
          report_ref,
        });
        let holdIds = [];
        if (result === "fail" && !batch.quarantined) {
          this._emit("BATCH_QUARANTINED", "fabrication_batch", batch_id, `试验失效，批次隔离（${test_id}）`, {
            test_id,
            reason: `材料试验 ${test_id} 失效：${test_type}`,
          });
          holdIds = this._propagateBatchFailure(batch_id, test_id);
        }
        return { batch_id, test_id, result, hold_ids: holdIds };
      },
    );
  }

  // ---------- 变更传播与处置 ----------

  /** 构件当前实际采用的主张引用：已下发工单按工单快照版本，否则按最新设计版本。 */
  _citedClaims(comp) {
    if (!comp.design_id) return { design: null, versionDetail: null, citations: [] };
    const design = this._getDesign(comp.design_id);
    const version = comp.design_version ?? design.current_version;
    const versionDetail = design.versions.find((v) => v.version === version);
    return { design, versionDetail, citations: versionDetail.citations };
  }

  _openHold(componentId, source, payload, reason) {
    const duplicate = [...this.holds.values()].some(
      (h) =>
        h.component_id === componentId &&
        h.status === "open" &&
        h.source_type === source.source_type &&
        (source.source_type === "claim"
          ? h.claim_id === source.claim_id && h.from_version === payload.from_version
          : h.batch_id === source.batch_id && h.test_id === payload.test_id),
    );
    if (duplicate) return null;
    const holdId = `hold-${String(this.holds.size + 1).padStart(4, "0")}`;
    this._emit("PROPAGATION_HOLD_OPENED", "propagation_hold", holdId, reason, {
      component_id: componentId,
      ...payload,
      required_roles: source.required_roles,
    });
    const comp = this._getComponent(componentId);
    if (!comp.frozen) {
      this._emit("COMPONENT_FROZEN", "component", componentId, "受变更影响，局部停工", {
        hold_id: holdId,
        source_type: payload.source_type,
      });
    }
    // 已经制造或安装的构件不能被"改回去"：只追加隔离记录。
    if (["manufactured", "installed"].includes(comp.status)) {
      this._emit("QUARANTINE_RECORDED", "component", componentId, `追加隔离记录（${holdId}）`, {
        reason,
        source_hold_id: holdId,
      });
    }
    return holdId;
  }

  _propagateClaimChange(claimId, fromVersion, toVersion, reason) {
    const holdIds = [];
    for (const comp of this.components.values()) {
      if (comp.status === "replaced") continue;
      const { citations } = this._citedClaims(comp);
      const citedVersion = citations.find((c) => c.claim_id === claimId)?.claim_version;
      if (citedVersion === undefined) continue; // 不引用该主张的构件（如底座）不冻结
      if (toVersion !== null && citedVersion === toVersion) continue; // 已采用新版
      const id = this._openHold(
        comp.id,
        { source_type: "claim", claim_id: claimId, required_roles: [HISTORICAL_LEAD, STRUCTURAL_LEAD] },
        {
          source_type: "claim",
          claim_id: claimId,
          from_version: fromVersion,
          to_version: toVersion,
          reason,
        },
        `主张 ${claimId} 更正/撤回影响构件 ${comp.id}`,
      );
      if (id) holdIds.push(id);
    }
    return holdIds;
  }

  _propagateBatchFailure(batchId, testId) {
    const batch = this._getBatch(batchId);
    const holdIds = [];
    for (const componentId of batch.component_ids) {
      const comp = this.components.get(componentId);
      if (!comp || comp.status === "replaced") continue;
      const id = this._openHold(
        componentId,
        { source_type: "batch", batch_id: batchId, required_roles: [STRUCTURAL_LEAD] },
        {
          source_type: "batch",
          batch_id: batchId,
          test_id: testId,
          reason: `批次 ${batchId} 材料试验失效`,
        },
        `材料批次 ${batchId} 失效影响构件 ${componentId}`,
      );
      if (id) holdIds.push(id);
    }
    return holdIds;
  }

  /** 史实负责人与结构负责人按职责对处置单签认；主张变更需双签，材料失效仅结构签认。 */
  confirmDisposition(cmd) {
    const { hold_id: holdId, role, decision, decided_by, new_design_version: newDesignVersion, note, idempotency_key: key } = cmd;
    const hold = this._getHold(holdId);
    return this._withIdempotency(
      key,
      { command: "confirmDisposition", hold_id: holdId, role, decision, decided_by, newDesignVersion, note },
      () => {
        if (hold.status !== "open") throw new ConflictError("处置单已闭环", { hold_id: holdId });
        if (!hold.required_roles.includes(role)) {
          throw new ConflictError("该角色无权签认此处置单", { hold_id: holdId, role, required: hold.required_roles });
        }
        if (hold.confirmations.some((c) => c.role === role)) {
          throw new ConflictError("该角色已签认，签认记录不可修改", { hold_id: holdId, role });
        }
        if (!["continue", "rework", "replace"].includes(decision)) {
          throw new ConflictError("处置必须是 continue、rework 或 replace", { decision });
        }
        // 双签场景：最后一位签认前先比对意见，不一致直接拒绝，不写任何签认事件，
        // 负责人可协商后以一致意见重新签认。
        const willComplete = hold.confirmations.length === hold.required_roles.length - 1;
        if (willComplete && hold.confirmations.some((c) => c.decision !== decision)) {
          throw new ConflictError("两位负责人处置意见不一致，需统一后再闭环", {
            hold_id: holdId,
            existing_decisions: hold.confirmations.map((c) => c.decision),
            incoming: decision,
          });
        }
        const comp = this._getComponent(hold.component_id);

        if (hold.source_type === "claim") {
          if (decision === "continue" && hold.to_version === null) {
            throw new ConflictError("主张已撤回，不能按原方案继续", { hold_id: holdId });
          }
          if (decision === "rework") {
            if (!newDesignVersion) throw new ConflictError("返工必须指定采用新主张版本的设计版本", { hold_id: holdId });
            const { design } = this._citedClaims(comp);
            const dv = design.versions.find((v) => v.version === newDesignVersion);
            if (!dv) throw new NotFoundError(`设计 ${design.id} 的版本`, newDesignVersion);
            const cited = dv.citations.find((c) => c.claim_id === hold.claim_id);
            if (!cited || cited.claim_version !== hold.to_version) {
              throw new ConflictError("返工设计必须引用更正后的主张版本", {
                hold_id: holdId,
                expected_claim_version: hold.to_version,
              });
            }
          }
        } else {
          if (decision === "continue") {
            throw new ConflictError("材料批次已隔离，不能继续使用", { hold_id: holdId });
          }
          if (decision === "rework") {
            if (!comp.batch_id || comp.batch_id === hold.batch_id) {
              throw new ConflictError("返工前必须改绑到未隔离的新材料批次", { hold_id: holdId });
            }
            if (this._getBatch(comp.batch_id).quarantined) {
              throw new ConflictError("新绑定批次同样处于隔离状态", { batch_id: comp.batch_id });
            }
          }
        }

        this._emit("DISPOSITION_CONFIRMED", "propagation_hold", holdId, `${role} 签认：${decision}`, {
          role,
          decision,
          decided_by,
          new_design_version: newDesignVersion ?? null,
          note: note ?? null,
        });

        const refreshed = this._getHold(holdId);
        if (refreshed.confirmations.length < refreshed.required_roles.length) {
          return { hold_id: holdId, status: "awaiting_other_role", pending_roles: this._pendingRoles(refreshed) };
        }
        const outcome = refreshed.confirmations[0].decision;
        const chosenDesignVersion =
          [...refreshed.confirmations].reverse().find((c) => c.new_design_version)?.new_design_version ?? null;
        this._emit("HOLD_RESOLVED", "propagation_hold", holdId, `处置闭环：${outcome}`, {
          outcome,
          new_design_version: chosenDesignVersion,
        });
        this._applyOutcome(hold, outcome, chosenDesignVersion, decided_by);
        return { hold_id: holdId, status: "resolved", outcome };
      },
    );
  }

  _pendingRoles(hold) {
    return hold.required_roles.filter((r) => !hold.confirmations.some((c) => c.role === r));
  }

  _applyOutcome(hold, outcome, newDesignVersion, decidedBy) {
    const comp = this._getComponent(hold.component_id);
    if (outcome === "continue") {
      this._emit("COMPONENT_UNFROZEN", "component", comp.id, "经确认继续，解除停工", { hold_id: hold.id });
      return;
    }
    if (outcome === "rework") {
      const alreadyMade = ["manufactured", "installed"].includes(comp.status);
      this._emit("COMPONENT_REWORK_STARTED", "component", comp.id, "开工返工", {
        hold_id: hold.id,
        design_version: newDesignVersion,
      });
      if (alreadyMade) {
        // 已制造/安装件：原检验与隔离记录不动，仅追加纠正记录。
        this._emit("CORRECTIVE_ACTION_RECORDED", "component", comp.id, `追加纠正记录（${hold.id}）`, {
          source_hold_id: hold.id,
          action: newDesignVersion
            ? `按设计 v${newDesignVersion} 返工，原检验记录保留备查`
            : "更换合格材料后返工，原检验记录保留备查",
          recorded_by: decidedBy,
        });
      }
      this._emit("COMPONENT_UNFROZEN", "component", comp.id, "返工方案确认，解除停工", { hold_id: hold.id });
      return;
    }
    // replace：原件作废替换，历史记录整体保留。
    this._emit("COMPONENT_REPLACED", "component", comp.id, "判定替换，原件作废", {
      hold_id: hold.id,
      recorded_by: decidedBy,
    });
    if (["manufactured", "installed"].includes(comp.status) || comp.quarantines.length > 0) {
      this._emit("CORRECTIVE_ACTION_RECORDED", "component", comp.id, `替换纠正记录（${hold.id}）`, {
        source_hold_id: hold.id,
        action: "原件隔离封存并加工替换件，原检验记录保留备查",
        recorded_by: decidedBy,
      });
    }
  }

  // ---------- 放行门禁 ----------

  evaluateGate(componentId, kind, depictions = []) {
    const comp = this._getComponent(componentId);
    const violations = [];
    const push = (code, message) => violations.push({ code, message });

    if (comp.status === "replaced") push("COMPONENT_REPLACED", "构件已被替换件取代，不得放行");
    if (comp.frozen) push("COMPONENT_FROZEN", "构件处于停工冻结状态");
    const openHolds = [...this.holds.values()].filter((h) => h.component_id === componentId && h.status === "open");
    if (openHolds.length > 0) {
      push("OPEN_DISPOSITION", `存在 ${openHolds.length} 张待决处置单：${openHolds.map((h) => h.id).join("、")}`);
    }

    const { design, versionDetail } = this._citedClaims(comp);
    if (!design) {
      push("NO_DESIGN", "构件尚无设计版本");
    } else {
      for (const c of versionDetail.citations) {
        const claim = this.claims.get(c.claim_id);
        if (!claim) {
          push("CLAIM_MISSING", `引用的主张 ${c.claim_id} 不存在`);
          continue;
        }
        const v = claim.versions.find((x) => x.version === c.claim_version);
        if (claim.status === "withdrawn" || v.status === "withdrawn") {
          push("CLAIM_WITHDRAWN", `引用的主张 ${c.claim_id}@v${c.claim_version} 已撤回`);
        } else if (v.status === "superseded") {
          // 修订取代旧版：除非两位负责人已对"该构件按原版本继续"签认，否则阻断放行。
          const acceptedContinue = [...this.holds.values()].some(
            (h) =>
              h.component_id === componentId &&
              h.source_type === "claim" &&
              h.claim_id === c.claim_id &&
              h.status === "resolved" &&
              h.outcome === "continue" &&
              h.from_version === c.claim_version,
          );
          if (!acceptedContinue) {
            push("CLAIM_SUPERSEDED", `引用的主张 ${c.claim_id}@v${c.claim_version} 已被新版取代`);
          }
        }
      }
      for (const opinionId of versionDetail.opinion_ids) {
        const opinion = this.opinions.get(opinionId);
        if (!opinion) {
          push("OPINION_MISSING", `采纳的专家意见 ${opinionId} 不存在`);
          continue;
        }
        const bound = versionDetail.citations.find((c) => c.claim_id === opinion.claim_id);
        if (!bound || bound.claim_version !== opinion.claim_version) {
          push("OPINION_SCOPE_VIOLATION", `专家意见 ${opinionId} 不属于设计引用的主张版本`);
        }
      }
      for (const d of depictions) {
        if (versionDetail.allowed_depiction.prohibited.includes(d)) {
          push("DEPICTION_PROHIBITED", `表现元素「${d}」在允许的表现范围之外（明令禁止）`);
        } else if (!versionDetail.allowed_depiction.permitted.includes(d)) {
          push("DEPICTION_OUT_OF_RANGE", `表现元素「${d}」不在允许的表现范围内`);
        }
      }
    }

    if (comp.batch_id) {
      const batch = this.batches.get(comp.batch_id);
      if (batch.quarantined) push("BATCH_QUARANTINED", `材料批次 ${comp.batch_id} 已隔离`);
    }

    if (kind === "installation" || kind === "label") {
      const finalPass = [...comp.inspections]
        .reverse()
        .find((i) => i.stage === "final" && i.result === "pass");
      if (!finalPass) {
        push("NO_FINAL_INSPECTION", "缺少合格的成品检验");
      } else if (comp.last_rework_at && finalPass.recorded_at <= comp.last_rework_at) {
        push("INSPECTION_STALE", "成品检验早于最近一次返工，需重新检验");
      }
    }
    return violations;
  }

  /** 安装/铭牌放行：门禁通过才产生放行版本；被拒绝也留痕，且命令可重试。 */
  requestRelease(cmd) {
    const { component_id: componentId, kind, requested_by, depictions = [], idempotency_key: key } = cmd;
    if (!["installation", "label"].includes(kind)) throw new ConflictError("放行类型必须是 installation 或 label", { kind });
    this._getComponent(componentId);
    return this._withIdempotency(
      key,
      { command: "requestRelease", component_id: componentId, kind, requested_by, depictions },
      () => {
        const violations = this.evaluateGate(componentId, kind, depictions);
        if (violations.length > 0) {
          this._emit("RELEASE_REJECTED", "installation_release", componentId, `${kind} 放行被门禁拒绝`, {
            kind,
            requested_by,
            violations,
          });
          throw new GateBlockedError(violations);
        }
        const comp = this._getComponent(componentId);
        const { design, versionDetail } = this._citedClaims(comp);
        const batch = comp.batch_id ? this.batches.get(comp.batch_id) : null;
        const finalInspection = [...comp.inspections].reverse().find((i) => i.stage === "final" && i.result === "pass");
        const snapshot = {
          component_id: componentId,
          design_id: design.id,
          design_version: versionDetail.version,
          design_content_hash: versionDetail.content_hash,
          citations: versionDetail.citations.map((c) => ({ ...c })),
          batch_id: comp.batch_id,
          batch_test_ids: batch ? batch.tests.map((t) => t.test_id) : [],
          final_inspection_id: finalInspection.inspection_id,
          hold_ids: [...this.holds.values()].filter((h) => h.component_id === componentId).map((h) => h.id),
        };
        const history = this.releases.get(componentId) ?? [];
        const version = history.filter((r) => r.kind === kind).length + 1;
        const eventType = kind === "installation" ? "INSTALLATION_CLEARED" : "LABEL_RELEASED";
        this._emit(eventType, "installation_release", componentId, `${kind} 放行 v${version}`, {
          kind,
          version,
          requested_by,
          gate_snapshot: snapshot,
        });
        return { component_id: componentId, kind, version, gate_snapshot: snapshot };
      },
    );
  }

  // ---------- 反查：主张、设计决策、材料证据、放行版本一链到底 ----------

  traceComponent(componentId) {
    const comp = this._getComponent(componentId);
    const { design, versionDetail } = this._citedClaims(comp);
    let claimDetails = [];
    let opinionDetails = [];
    if (design && versionDetail) {
      claimDetails = versionDetail.citations.map((c) => {
        const claim = this.claims.get(c.claim_id);
        const v = claim.versions.find((x) => x.version === c.claim_version);
        return {
          claim_id: c.claim_id,
          kind: claim.kind,
          subject: claim.subject,
          cited_version: c.claim_version,
          cited_version_status: v.status,
          current_version: claim.current_version,
          statement: v.statement,
          claim_status: claim.status,
        };
      });
      opinionDetails = versionDetail.opinion_ids.map((id) => {
        const o = this.opinions.get(id);
        return { opinion_id: id, claim_id: o.claim_id, claim_version: o.claim_version, expert: o.expert, conclusion: o.conclusion };
      });
    }
    const batch = comp.batch_id
      ? (() => {
          const b = this.batches.get(comp.batch_id);
          return { batch_id: b.id, material: b.material, quarantined: b.quarantined, tests: b.tests.map((t) => ({ ...t })) };
        })()
      : null;
    return {
      component: {
        component_id: comp.id,
        name: comp.name,
        discipline: comp.discipline,
        status: comp.status,
        frozen: comp.frozen,
        design_id: comp.design_id,
        executed_design_version: comp.design_version,
      },
      design: design
        ? {
            design_id: design.id,
            current_version: design.current_version,
            current_content_text: design.versions.find((v) => v.version === design.current_version).content_text,
            executed_version: versionDetail.version,
            content_text: versionDetail.content_text,
            content_hash: versionDetail.content_hash,
            allowed_depiction: versionDetail.allowed_depiction,
            decisions: design.decisions.map((d) => ({ ...d })),
          }
        : null,
      claims: claimDetails,
      opinions: opinionDetails,
      batch,
      inspections: comp.inspections.map((i) => ({ ...i })),
      quarantines: comp.quarantines.map((q) => ({ ...q })),
      corrections: comp.corrections.map((q) => ({ ...q })),
      holds: [...this.holds.values()].filter((h) => h.component_id === componentId).map((h) => ({
        hold_id: h.id,
        source_type: h.source_type,
        claim_id: h.claim_id,
        from_version: h.from_version,
        to_version: h.to_version,
        batch_id: h.batch_id,
        status: h.status,
        outcome: h.outcome,
        required_roles: h.required_roles,
        confirmations: h.confirmations.map((c) => ({ ...c })),
      })),
      releases: (this.releases.get(componentId) ?? []).map((r) => ({
        kind: r.kind,
        version: r.version,
        released_at: r.released_at,
        gate_snapshot: r.gate_snapshot,
      })),
    };
  }

  listOpenHolds() {
    return [...this.holds.values()].filter((h) => h.status === "open").map((h) => ({
      hold_id: h.id,
      component_id: h.component_id,
      source_type: h.source_type,
      claim_id: h.claim_id,
      from_version: h.from_version,
      to_version: h.to_version,
      batch_id: h.batch_id,
      test_id: h.test_id,
      reason: h.reason,
      required_roles: h.required_roles,
      pending_roles: this._pendingRoles(h),
    }));
  }

  // ---------- 事件投影 ----------

  _apply(event) {
    this.seq = Math.max(this.seq, Number(event.event_id.replace(/\D/g, "")) || 0);
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "CLAIM_SUBMITTED":
        this.claims.set(event.aggregate_id, {
          id: event.aggregate_id,
          kind: p.kind,
          subject: p.subject,
          status: "active",
          current_version: 1,
          versions: [{ version: 1, statement: p.statement, status: "active", parent_version: null, fork: false }],
        });
        break;
      case "CLAIM_CORRECTED": {
        const claim = this.claims.get(event.aggregate_id);
        if (p.mode === "revise") claim.versions.find((v) => v.version === p.from_version).status = "superseded";
        claim.versions.push({
          version: p.new_version,
          statement: p.new_statement,
          status: "active",
          reason: p.reason,
          parent_version: p.from_version,
          fork: p.mode === "fork",
        });
        claim.current_version = p.new_version;
        break;
      }
      case "CLAIM_WITHDRAWN": {
        const claim = this.claims.get(event.aggregate_id);
        claim.status = "withdrawn";
        claim.versions.find((v) => v.version === p.version).status = "withdrawn";
        break;
      }
      case "EXPERT_OPINION_RECORDED":
        this.opinions.set(event.aggregate_id, {
          id: event.aggregate_id,
          claim_id: p.claim_id,
          claim_version: p.claim_version,
          expert: p.expert,
          conclusion: p.conclusion,
        });
        break;
      case "DESIGN_SUBMITTED": {
        const entry = {
          version: p.version,
          citations: p.citations.map((c) => ({ ...c })),
          allowed_depiction: {
            permitted: p.allowed_depiction.permitted.slice(),
            prohibited: p.allowed_depiction.prohibited.slice(),
          },
          content_text: p.content_text,
          content_hash: p.content_hash,
          opinion_ids: p.opinion_ids.slice(),
          submitted_at: event.occurred_at,
        };
        const design = this.designs.get(event.aggregate_id);
        if (design) {
          design.versions.push(entry);
          design.current_version = p.version;
        } else {
          this.designs.set(event.aggregate_id, {
            id: event.aggregate_id,
            component_id: p.component_id,
            current_version: p.version,
            versions: [entry],
            decisions: [],
          });
        }
        const designComponent = this.components.get(p.component_id);
        if (designComponent && !designComponent.design_id) designComponent.design_id = event.aggregate_id;
        break;
      }
      case "DESIGN_DECISION_RECORDED": {
        const design = this._getDesign(event.aggregate_id);
        design.decisions.push({
          decision_id: p.decision_id,
          decision: p.decision,
          decided_by: p.decided_by,
          at: event.occurred_at,
        });
        break;
      }
      case "COMPONENT_REGISTERED":
        this.components.set(event.aggregate_id, {
          id: event.aggregate_id,
          name: p.name,
          discipline: p.discipline,
          design_id: null,
          design_version: null,
          batch_id: null,
          status: "registered",
          frozen: false,
          last_rework_at: null,
          inspections: [],
          quarantines: [],
          corrections: [],
        });
        break;
      case "COMPONENT_FROZEN":
        this.components.get(event.aggregate_id).frozen = true;
        break;
      case "COMPONENT_UNFROZEN":
        this.components.get(event.aggregate_id).frozen = false;
        break;
      case "WORK_ORDER_ISSUED": {
        const comp = this.components.get(event.aggregate_id);
        comp.design_id = p.design_id;
        comp.design_version = p.design_version;
        comp.status = "in_production";
        break;
      }
      case "INSPECTION_RECORDED": {
        const comp = this.components.get(event.aggregate_id);
        comp.inspections.push({
          inspection_id: p.inspection_id,
          stage: p.stage,
          result: p.result,
          note: p.note,
          recorded_at: event.occurred_at,
        });
        if (p.stage === "final" && p.result === "pass") comp.status = "manufactured";
        break;
      }
      case "QUARANTINE_RECORDED": {
        const comp = this.components.get(event.aggregate_id);
        comp.quarantines.push({
          record_id: `q-${comp.quarantines.length + 1}`,
          reason: p.reason,
          source_hold_id: p.source_hold_id,
          recorded_at: event.occurred_at,
        });
        break;
      }
      case "CORRECTIVE_ACTION_RECORDED": {
        const comp = this.components.get(event.aggregate_id);
        comp.corrections.push({
          record_id: `c-${comp.corrections.length + 1}`,
          action: p.action,
          recorded_by: p.recorded_by,
          source_hold_id: p.source_hold_id,
          recorded_at: event.occurred_at,
        });
        break;
      }
      case "COMPONENT_REWORK_STARTED": {
        const comp = this.components.get(event.aggregate_id);
        comp.status = "reworking";
        comp.last_rework_at = event.occurred_at;
        if (p.design_version) comp.design_version = p.design_version;
        break;
      }
      case "COMPONENT_REPLACED":
        this.components.get(event.aggregate_id).status = "replaced";
        break;
      case "BATCH_REGISTERED":
        this.batches.set(event.aggregate_id, {
          id: event.aggregate_id,
          material: p.material,
          quarantined: false,
          component_ids: [],
          tests: [],
        });
        break;
      case "COMPONENT_ASSIGNED_BATCH": {
        const comp = this.components.get(event.aggregate_id);
        if (comp.batch_id && comp.batch_id !== p.batch_id) {
          const old = this.batches.get(comp.batch_id);
          old.component_ids = old.component_ids.filter((id) => id !== comp.id);
        }
        comp.batch_id = p.batch_id;
        const batch = this.batches.get(p.batch_id);
        if (!batch.component_ids.includes(comp.id)) batch.component_ids.push(comp.id);
        break;
      }
      case "MATERIAL_TEST_RECORDED": {
        const batch = this.batches.get(event.aggregate_id);
        batch.tests.push({
          test_id: p.test_id,
          test_type: p.test_type,
          result: p.result,
          report_ref: p.report_ref,
          recorded_at: event.occurred_at,
        });
        break;
      }
      case "BATCH_QUARANTINED":
        this.batches.get(event.aggregate_id).quarantined = true;
        break;
      case "PROPAGATION_HOLD_OPENED":
        this.holds.set(event.aggregate_id, {
          id: event.aggregate_id,
          component_id: p.component_id,
          source_type: p.source_type,
          claim_id: p.claim_id,
          from_version: p.from_version,
          to_version: p.to_version,
          batch_id: p.batch_id,
          test_id: p.test_id,
          reason: p.reason,
          status: "open",
          required_roles: p.required_roles,
          confirmations: [],
          opened_at: event.occurred_at,
        });
        break;
      case "DISPOSITION_CONFIRMED": {
        const hold = this.holds.get(event.aggregate_id);
        hold.confirmations.push({
          role: p.role,
          decision: p.decision,
          decided_by: p.decided_by,
          new_design_version: p.new_design_version,
          note: p.note,
          confirmed_at: event.occurred_at,
        });
        break;
      }
      case "HOLD_RESOLVED": {
        const hold = this.holds.get(event.aggregate_id);
        hold.status = "resolved";
        hold.outcome = p.outcome;
        hold.resolved_at = event.occurred_at;
        break;
      }
      case "RELEASE_REJECTED": {
        const list = this.rejections.get(event.aggregate_id) ?? [];
        list.push({ kind: p.kind, requested_by: p.requested_by, violations: p.violations, at: event.occurred_at });
        this.rejections.set(event.aggregate_id, list);
        break;
      }
      case "INSTALLATION_CLEARED": {
        const installed = this.components.get(event.aggregate_id);
        if (installed && installed.status === "manufactured") installed.status = "installed";
        const list = this.releases.get(event.aggregate_id) ?? [];
        list.push({
          kind: p.kind,
          version: p.version,
          released_at: event.occurred_at,
          gate_snapshot: p.gate_snapshot,
        });
        this.releases.set(event.aggregate_id, list);
        break;
      }
      case "LABEL_RELEASED": {
        const list = this.releases.get(event.aggregate_id) ?? [];
        list.push({
          kind: p.kind,
          version: p.version,
          released_at: event.occurred_at,
          gate_snapshot: p.gate_snapshot,
        });
        this.releases.set(event.aggregate_id, list);
        break;
      }
      case "IDEMPOTENCY_RECORDED":
        this.idempotency.set(event.aggregate_id, {
          command: p.command,
          request_hash: p.request_hash,
          result: p.result,
          error: p.error ?? null,
        });
        break;
      default:
        throw new DomainError("UNKNOWN_EVENT", `未知事件类型：${event.event_type}`, { event_type: event.event_type });
    }
    this.versions.set(`${event.aggregate_type}:${event.aggregate_id}`, event.version);
  }
}

export { HISTORICAL_LEAD, STRUCTURAL_LEAD };
