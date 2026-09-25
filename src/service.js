import { DomainError, EventStore, stableStringify } from "./event-store.js";
import { Projection } from "./projections.js";

const CLAIM_KINDS = new Set(["evidence", "inference"]);
const STAGES = ["designed", "in_fabrication", "fabricated", "installed"];
const DECISIONS = new Set(["continue", "rework", "replace"]);
/** 处置决定取最严格者：替换 > 返工 > 继续。 */
const STRICTNESS = { continue: 0, rework: 1, replace: 2 };

/**
 * 主张到构件的变更传播服务。
 *
 * 所有状态变化以事件追加；指令经 #run 统一登记幂等。传播规则：
 * - 主张更正/撤回：只波及引用了该主张版本的设计版本下的构件，未制造完成的停工，
 *   已制造/安装的追加隔离记录；系统按构件提出处置，由史实负责人确认。
 * - 材料试验失效：沿批次关联传播到同批次全部构件，由结构负责人确认处置。
 * - 处置全部确认后生效：继续则复工，返工则退回加工并追加纠正记录，替换则构件终态。
 */
export class SculptureReviewService {
  #store;
  #projection;
  #now;
  #staged = [];
  #eventSeq;

  constructor({ store, now } = {}) {
    this.#store = store ?? new EventStore();
    this.#now = now ?? (() => new Date().toISOString());
    this.#projection = new Projection();
    for (const event of this.#store.events) this.#projection.apply(event);
    this.#eventSeq = this.#store.events.length;
  }

  /** 从快照恢复服务：待决处置、安装门禁与指令登记全部延续。 */
  static restore(snapshot, options = {}) {
    return new SculptureReviewService({ ...options, store: EventStore.restore(snapshot) });
  }

  snapshot() {
    return this.#store.snapshot();
  }

  get events() {
    return this.#store.events;
  }

  // ---------- 指令统一入口：幂等登记 + 事件原子提交 ----------

  #run(commandId, payload, handler) {
    if (!commandId || typeof commandId !== "string") throw new DomainError("VALIDATION", "指令缺少 command_id");
    const fingerprint = stableStringify(payload);
    const prior = this.#store.commandRecord(commandId);
    if (prior) {
      if (prior.payload_fingerprint !== fingerprint) {
        throw new DomainError("REPLAY_CONFLICT", `指令 ${commandId} 内容发生变化，拒绝重放`);
      }
      if (prior.status === "rejected") throw new DomainError(prior.code, prior.message);
      return prior.result;
    }
    this.#staged = [];
    try {
      const result = handler();
      for (const event of this.#staged) this.#store.append(event);
      this.#store.recordCommand(commandId, { payload_fingerprint: fingerprint, status: "accepted", result });
      return result;
    } catch (error) {
      // 指令失败：暂存事件全部丢弃，投影回放到指令前状态
      this.#staged = [];
      this.#rebuild();
      const code = error instanceof DomainError ? error.code : "INTERNAL";
      this.#store.recordCommand(commandId, {
        payload_fingerprint: fingerprint,
        status: "rejected",
        code,
        message: error.message,
      });
      throw error;
    } finally {
      this.#staged = [];
    }
  }

  #rebuild() {
    this.#projection = new Projection();
    for (const event of this.#store.events) this.#projection.apply(event);
  }

  #emit(eventType, aggregateType, aggregateId, summary, payload) {
    const key = `${aggregateType}:${aggregateId}`;
    const version = (this.#projection.aggregateSeq.get(key) ?? 0) + 1;
    const event = {
      event_id: `evt-${String(++this.#eventSeq).padStart(6, "0")}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.#now(),
      version,
      summary,
      payload,
    };
    this.#staged.push(event);
    this.#projection.apply(event);
    return event;
  }

  // ---------- 读取辅助 ----------

  #mustClaim(claimId) {
    const claim = this.#projection.claims.get(claimId);
    if (!claim) throw new DomainError("NOT_FOUND", `主张不存在：${claimId}`);
    return claim;
  }

  #claimVersion(claimId, version) {
    return this.#projection.claims.get(claimId)?.versions.get(version) ?? null;
  }

  #mustDesignVersion(designId, version) {
    const design = this.#projection.designs.get(designId);
    const record = design?.versions.get(version);
    if (!record) throw new DomainError("NOT_FOUND", `设计版本不存在：${designId}@${version}`);
    return record;
  }

  #mustComponent(componentId) {
    const component = this.#projection.components.get(componentId);
    if (!component) throw new DomainError("NOT_FOUND", `构件不存在：${componentId}`);
    return component;
  }

  #pendingOf(componentId) {
    return [...this.#projection.dispositions.values()].filter(
      (d) => d.component_id === componentId && d.status === "pending",
    );
  }

  // ---------- 主张：史实证据与艺术推断分开版本化 ----------

  submitClaim({ command_id, actor, claim_id, kind, statement, summary }) {
    return this.#run(command_id, { actor, claim_id, kind, statement, summary }, () => {
      if (!CLAIM_KINDS.has(kind)) throw new DomainError("VALIDATION", `主张类别必须是 ${[...CLAIM_KINDS].join("/")}`);
      if (this.#projection.claims.has(claim_id)) throw new DomainError("CONFLICT", `主张已存在：${claim_id}`);
      if (!statement) throw new DomainError("VALIDATION", "主张内容不能为空");
      this.#emit("CLAIM_SUBMITTED", "historical_claim", claim_id, summary ?? `登记主张 ${claim_id}（${kind}）`, {
        kind,
        statement,
        version: 1,
        submitted_by: actor.id,
      });
      return { claim_id, version: 1 };
    });
  }

  /** 更正主张：基于最新版本产生后继版本，旧版本标记为被取代，并沿引用链传播。 */
  correctClaim({ command_id, actor, claim_id, base_version, statement, reason }) {
    return this.#run(command_id, { actor, claim_id, base_version, statement, reason }, () => {
      const claim = this.#mustClaim(claim_id);
      if (base_version !== claim.latest_version) {
        throw new DomainError("CONFLICT", `更正必须基于最新版本 ${claim.latest_version}，收到 ${base_version}`);
      }
      if (claim.versions.get(base_version).status !== "active") {
        throw new DomainError("STATE", `主张版本 ${claim_id}@${base_version} 已失效，不能作为更正基线`);
      }
      if (!statement) throw new DomainError("VALIDATION", "更正后的主张内容不能为空");
      const toVersion = base_version + 1;
      this.#emit("CLAIM_CORRECTED", "historical_claim", claim_id, `更正主张 ${claim_id}：v${base_version} → v${toVersion}`, {
        from_version: base_version,
        to_version: toVersion,
        statement,
        reason,
        corrected_by: actor.id,
      });
      const affected = this.#propagateClaimChange(claim_id, base_version, "claim_corrected");
      return { claim_id, version: toVersion, affected_components: affected };
    });
  }

  /** 撤回主张：作用于最新有效版本，并沿引用链传播。 */
  retractClaim({ command_id, actor, claim_id, version, reason }) {
    return this.#run(command_id, { actor, claim_id, version, reason }, () => {
      const claim = this.#mustClaim(claim_id);
      if (version !== claim.latest_version) {
        throw new DomainError("CONFLICT", `撤回必须针对最新版本 ${claim.latest_version}，收到 ${version}`);
      }
      if (claim.versions.get(version).status !== "active") {
        throw new DomainError("STATE", `主张版本 ${claim_id}@${version} 已失效，不能撤回`);
      }
      this.#emit("CLAIM_RETRACTED", "historical_claim", claim_id, `撤回主张 ${claim_id}@v${version}`, {
        version,
        reason,
        retracted_by: actor.id,
      });
      const affected = this.#propagateClaimChange(claim_id, version, "claim_retracted");
      return { claim_id, version, affected_components: affected };
    });
  }

  // ---------- 设计：基线版本防覆盖，专家意见按版本作用 ----------

  submitDesign({ command_id, actor, design_id, baseline_version, claim_refs = [], summary }) {
    return this.#run(command_id, { actor, design_id, baseline_version, claim_refs, summary }, () => {
      const design = this.#projection.designs.get(design_id);
      const latest = design?.latest_version ?? 0;
      if (baseline_version !== latest) {
        throw new DomainError(
          "CONFLICT",
          `并行提交冲突：设计 ${design_id} 当前基线为 ${latest}，收到 ${baseline_version}，已拒绝覆盖`,
        );
      }
      for (const ref of claim_refs) {
        if (!ref.representation_scope) {
          throw new DomainError("VALIDATION", `引用主张 ${ref.claim_id} 必须声明允许的表现范围`);
        }
        const claimVersion = this.#claimVersion(ref.claim_id, ref.claim_version);
        if (!claimVersion) throw new DomainError("NOT_FOUND", `引用的主张版本不存在：${ref.claim_id}@${ref.claim_version}`);
        if (claimVersion.status !== "active") {
          throw new DomainError("STATE", `引用的主张 ${ref.claim_id}@${ref.claim_version} 已失效，设计必须改用有效版本`);
        }
      }
      const version = latest + 1;
      this.#emit("DESIGN_SUBMITTED", "design_version", design_id, summary ?? `提交设计 ${design_id} 第 ${version} 版`, {
        version,
        baseline_version,
        claim_refs,
        submitted_by: actor.id,
      });
      return { design_id, version };
    });
  }

  /** 专家意见只作用于指定的设计版本，不随版本修订迁移。 */
  recordExpertOpinion({ command_id, actor, design_id, design_version, opinion }) {
    return this.#run(command_id, { actor, design_id, design_version, opinion }, () => {
      this.#mustDesignVersion(design_id, design_version);
      if (!opinion) throw new DomainError("VALIDATION", "专家意见内容不能为空");
      this.#emit("EXPERT_OPINION_RECORDED", "design_version", design_id, `记录专家意见（${design_id}@${design_version}）`, {
        design_version,
        expert: actor.id,
        expert_role: actor.role,
        opinion,
      });
      return { design_id, design_version };
    });
  }

  reviewDesign({ command_id, actor, design_id, design_version, decision, comment }) {
    return this.#run(command_id, { actor, design_id, design_version, decision, comment }, () => {
      this.#mustDesignVersion(design_id, design_version);
      if (!["approved", "rejected"].includes(decision)) throw new DomainError("VALIDATION", "审查结论必须是 approved/rejected");
      this.#emit("DESIGN_REVIEWED", "design_version", design_id, `审查设计 ${design_id}@${design_version}：${decision}`, {
        design_version,
        decision,
        reviewer: actor.id,
        comment,
      });
      return { design_id, design_version, decision };
    });
  }

  // ---------- 构件与批次 ----------

  registerComponent({ command_id, actor, component_id, component_type, design_id, design_version, batch_id, replaces }) {
    return this.#run(command_id, { actor, component_id, component_type, design_id, design_version, batch_id, replaces }, () => {
      if (this.#projection.components.has(component_id)) throw new DomainError("CONFLICT", `构件已存在：${component_id}`);
      if (!component_type) throw new DomainError("VALIDATION", "构件类型不能为空");
      const design = this.#mustDesignVersion(design_id, design_version);
      if (design.status !== "approved") throw new DomainError("STATE", `设计 ${design_id}@${design_version} 未获批，不能登记构件`);
      const batch = this.#projection.batches.get(batch_id);
      if (!batch) throw new DomainError("NOT_FOUND", `材料批次不存在：${batch_id}`);
      if (batch.invalidated) throw new DomainError("STATE", `材料批次 ${batch_id} 已失效，不能用于新构件`);
      if (replaces) {
        const predecessor = this.#mustComponent(replaces);
        if (predecessor.work_state !== "replaced") throw new DomainError("STATE", `被替换构件 ${replaces} 尚未标记替换`);
      }
      this.#emit("COMPONENT_REGISTERED", "component", component_id, `登记构件 ${component_id}（${component_type}）`, {
        component_type,
        design_id,
        design_version,
        batch_id,
        replaces: replaces ?? null,
        registered_by: actor.id,
      });
      return { component_id };
    });
  }

  /** 把构件改派到新的设计版本：更正传播后的修复路径，只追加事件，不改写历史。 */
  reassignComponentDesign({ command_id, actor, component_id, design_id, design_version, reason }) {
    return this.#run(command_id, { actor, component_id, design_id, design_version, reason }, () => {
      const component = this.#mustComponent(component_id);
      if (component.work_state === "replaced") throw new DomainError("STATE", `构件 ${component_id} 已替换，不能改派`);
      const design = this.#mustDesignVersion(design_id, design_version);
      if (design.status !== "approved") throw new DomainError("STATE", `设计 ${design_id}@${design_version} 未获批，不能改派`);
      const from = { design_id: component.design_id, design_version: component.design_version };
      this.#emit("COMPONENT_REASSIGNED", "component", component_id, `构件 ${component_id} 改派设计 ${design_id}@${design_version}`, {
        from,
        to: { design_id, design_version },
        reason,
        reassigned_by: actor.id,
      });
      return { component_id, from, to: { design_id, design_version } };
    });
  }

  /** 推进加工阶段；停工/隔离或存在待决处置时禁止推进。安装必须走放行门禁。 */
  advanceComponentStage({ command_id, actor, component_id, to_stage, inspection }) {
    return this.#run(command_id, { actor, component_id, to_stage, inspection }, () => {
      const component = this.#mustComponent(component_id);
      if (to_stage === "installed") throw new DomainError("VALIDATION", "安装必须经安装放行门禁 requestInstallation");
      const target = STAGES.indexOf(to_stage);
      const current = STAGES.indexOf(component.stage);
      if (target !== current + 1) {
        throw new DomainError("STATE", `构件 ${component_id} 不能从 ${component.stage} 推进到 ${to_stage}；原检验记录不可改写`);
      }
      this.#mustBeWorkable(component);
      if (to_stage === "fabricated") this.#mustInspection(inspection);
      this.#emit("COMPONENT_STAGE_ADVANCED", "component", component_id, `构件 ${component_id} 推进到 ${to_stage}`, {
        from_stage: component.stage,
        to_stage,
        inspection: inspection ?? null,
        advanced_by: actor.id,
      });
      return { component_id, stage: to_stage };
    });
  }

  registerBatch({ command_id, actor, batch_id, material }) {
    return this.#run(command_id, { actor, batch_id, material }, () => {
      if (this.#projection.batches.has(batch_id)) throw new DomainError("CONFLICT", `批次已存在：${batch_id}`);
      if (!material) throw new DomainError("VALIDATION", "批次材料不能为空");
      this.#emit("BATCH_REGISTERED", "fabrication_batch", batch_id, `登记材料批次 ${batch_id}（${material}）`, {
        material,
        registered_by: actor.id,
      });
      return { batch_id };
    });
  }

  /** 记录材料试验；试验失败使批次失效，并沿批次关联传播到全部构件。 */
  recordMaterialTest({ command_id, actor, batch_id, test_id, result, summary }) {
    return this.#run(command_id, { actor, batch_id, test_id, result, summary }, () => {
      const batch = this.#projection.batches.get(batch_id);
      if (!batch) throw new DomainError("NOT_FOUND", `材料批次不存在：${batch_id}`);
      if (batch.tests.some((t) => t.test_id === test_id)) {
        throw new DomainError("CONFLICT", `试验 ${test_id} 已记录，试验结果不可改写`);
      }
      if (!["passed", "failed"].includes(result)) throw new DomainError("VALIDATION", "试验结果必须是 passed/failed");
      this.#emit("MATERIAL_TESTED", "fabrication_batch", batch_id, summary ?? `批次 ${batch_id} 试验 ${test_id}：${result}`, {
        test_id,
        result,
        summary,
        tested_by: actor.id,
      });
      if (result !== "failed") return { batch_id, test_id, result, affected_components: [] };
      this.#emit("BATCH_INVALIDATED", "fabrication_batch", batch_id, `批次 ${batch_id} 因试验 ${test_id} 失效`, { test_id });
      const affected = this.#propagateBatchFailure(batch_id, test_id);
      return { batch_id, test_id, result, affected_components: affected };
    });
  }

  // ---------- 处置：系统提出，史实/结构负责人按职责确认 ----------

  confirmDisposition({ command_id, actor, disposition_id, decision, note }) {
    return this.#run(command_id, { actor, disposition_id, decision, note }, () => {
      const disposition = this.#projection.dispositions.get(disposition_id);
      if (!disposition) throw new DomainError("NOT_FOUND", `处置不存在：${disposition_id}`);
      if (disposition.status !== "pending") throw new DomainError("STATE", `处置 ${disposition_id} 已结案`);
      if (!DECISIONS.has(decision)) throw new DomainError("VALIDATION", "处置决定必须是 continue/rework/replace");
      if (!disposition.required_roles.includes(actor.role)) {
        throw new DomainError("ROLE", `处置 ${disposition_id} 需要 ${disposition.required_roles.join("/")} 确认，${actor.role} 无此职责`);
      }
      if (disposition.confirmations.some((c) => c.role === actor.role)) {
        throw new DomainError("CONFLICT", `职责 ${actor.role} 已确认过处置 ${disposition_id}`);
      }
      this.#emit("DISPOSITION_CONFIRMED", "disposition", disposition_id, `${actor.role} 确认处置 ${disposition_id}：${decision}`, {
        role: actor.role,
        decision,
        confirmed_by: actor.id,
        note,
      });
      const resolved = disposition.required_roles.every((role) =>
        this.#projection.dispositions.get(disposition_id).confirmations.some((c) => c.role === role),
      );
      if (resolved) this.#resolveDisposition(disposition_id);
      return structuredClone(this.#projection.dispositions.get(disposition_id));
    });
  }

  #resolveDisposition(dispositionId) {
    const disposition = this.#projection.dispositions.get(dispositionId);
    const action = disposition.confirmations.reduce(
      (strictest, c) => (STRICTNESS[c.decision] > STRICTNESS[strictest] ? c.decision : strictest),
      "continue",
    );
    this.#emit("DISPOSITION_RESOLVED", "disposition", dispositionId, `处置 ${dispositionId} 结案：${action}`, {
      component_id: disposition.component_id,
      action,
    });
    const component = this.#projection.components.get(disposition.component_id);
    if (component.work_state === "replaced") return;
    if (action !== "continue") {
      const payload = { disposition_id: dispositionId, action, note: `按处置 ${dispositionId} 执行 ${action}` };
      if (action === "rework" && (component.stage === "fabricated" || component.stage === "installed")) {
        payload.stage_reset_to = "in_fabrication";
      }
      this.#emit("COMPONENT_CORRECTION_RECORDED", "component", component.component_id, `构件 ${component.component_id} 追加纠正记录：${action}`, payload);
    }
    if (action !== "replace" && this.#pendingOf(component.component_id).length === 0) {
      this.#emit("COMPONENT_RESUMED", "component", component.component_id, `构件 ${component.component_id} 恢复作业`, {
        disposition_id: dispositionId,
      });
    }
  }

  // ---------- 安装放行门禁 ----------

  requestInstallation({ command_id, actor, component_id, inspection }) {
    return this.#run(command_id, { actor, component_id, inspection }, () => {
      const component = this.#mustComponent(component_id);
      const reasons = [];
      if (component.work_state !== "active") reasons.push(`构件处于 ${component.work_state} 状态`);
      const pending = this.#pendingOf(component_id);
      if (pending.length > 0) reasons.push(`存在待决处置：${pending.map((d) => d.disposition_id).join("、")}`);
      if (component.stage !== "fabricated" && component.stage !== "installed") reasons.push("构件尚未制造完成");
      if (component.stage === "fabricated") {
        try {
          this.#mustInspection(inspection);
        } catch (error) {
          reasons.push(error.message);
        }
      }
      const design = this.#mustDesignVersion(component.design_id, component.design_version);
      if (design.status !== "approved") reasons.push(`设计 ${component.design_id}@${component.design_version} 未获批`);
      for (const ref of design.claim_refs) {
        const claimVersion = this.#claimVersion(ref.claim_id, ref.claim_version);
        if (!claimVersion || claimVersion.status !== "active") {
          reasons.push(`引用的主张 ${ref.claim_id}@${ref.claim_version} 已失效`);
        }
      }
      const batch = this.#projection.batches.get(component.batch_id);
      if (batch?.invalidated) reasons.push(`材料批次 ${component.batch_id} 已失效`);
      const past = this.#projection.releases.get(component_id) ?? [];
      if (component.stage === "installed") {
        const last = past[past.length - 1];
        const changedSinceRelease =
          !last || last.design_version !== component.design_version || this.#resolvedAfter(component_id, last.cleared_at);
        if (!changedSinceRelease) reasons.push("自上次放行以来无更正或处置，无需重复放行");
      }
      if (reasons.length > 0) throw new DomainError("GATE", `安装门禁拒绝：${reasons.join("；")}`);
      const releaseVersion = past.length + 1;
      this.#emit("INSTALLATION_CLEARED", "installation_release", component_id, `构件 ${component_id} 安装放行（第 ${releaseVersion} 版）`, {
        release_version: releaseVersion,
        design_id: component.design_id,
        design_version: component.design_version,
        claim_versions: design.claim_refs.map((ref) => ({ ...ref })),
        batch_id: component.batch_id,
        cleared_by: actor.id,
      });
      if (component.stage === "fabricated") {
        this.#emit("COMPONENT_STAGE_ADVANCED", "component", component_id, `构件 ${component_id} 安装就位`, {
          from_stage: "fabricated",
          to_stage: "installed",
          inspection,
          advanced_by: actor.id,
        });
      }
      return { component_id, release_version: releaseVersion };
    });
  }

  // ---------- 变更传播 ----------

  /** 主张更正/撤回：只波及引用该主张版本的设计版本下的构件。 */
  #propagateClaimChange(claimId, claimVersion, triggerKind) {
    const affectedDesigns = new Set();
    for (const design of this.#projection.designs.values()) {
      for (const [version, record] of design.versions) {
        const hit = record.claim_refs.some((ref) => ref.claim_id === claimId && ref.claim_version === claimVersion);
        if (hit) affectedDesigns.add(`${design.design_id}@${version}`);
      }
    }
    const components = [...this.#projection.components.values()].filter(
      (c) => c.work_state !== "replaced" && affectedDesigns.has(`${c.design_id}@${c.design_version}`),
    );
    for (const component of components) {
      this.#raiseDisposition(
        component,
        { kind: triggerKind, claim_id: claimId, claim_version: claimVersion },
        ["historical_lead"],
        triggerKind === "claim_retracted" ? "replace" : "rework",
      );
    }
    return components.map((c) => c.component_id);
  }

  /** 批次失效：沿批次关联传播到同批次全部构件。 */
  #propagateBatchFailure(batchId, testId) {
    const components = [...this.#projection.components.values()].filter(
      (c) => c.batch_id === batchId && c.work_state !== "replaced",
    );
    for (const component of components) {
      const heavy = component.stage === "fabricated" || component.stage === "installed";
      this.#raiseDisposition(
        component,
        { kind: "batch_invalidated", batch_id: batchId, test_id: testId },
        ["structural_lead"],
        heavy ? "replace" : "rework",
      );
    }
    return components.map((c) => c.component_id);
  }

  /** 未制造完成的构件停工，已制造/安装的只追加隔离记录；随后提出处置。 */
  #raiseDisposition(component, trigger, requiredRoles, recommendedAction) {
    const dispositionId = `DISP-${String(this.#projection.dispositionCount + 1).padStart(4, "0")}`;
    if (component.stage === "fabricated" || component.stage === "installed") {
      this.#emit("COMPONENT_QUARANTINED", "component", component.component_id, `构件 ${component.component_id} 追加隔离记录`, {
        trigger,
        note: "已制造/安装构件只追加隔离与纠正记录，原检验保持不变",
      });
    } else {
      this.#emit("COMPONENT_FROZEN", "component", component.component_id, `构件 ${component.component_id} 停工`, { trigger });
    }
    this.#emit("DISPOSITION_PROPOSED", "disposition", dispositionId, `系统提出处置 ${dispositionId}（构件 ${component.component_id}）`, {
      component_id: component.component_id,
      trigger,
      required_roles: requiredRoles,
      recommended_action: recommendedAction,
    });
    return dispositionId;
  }

  #mustBeWorkable(component) {
    if (component.work_state !== "active") throw new DomainError("STATE", `构件 ${component.component_id} 处于 ${component.work_state} 状态，禁止推进`);
    const pending = this.#pendingOf(component.component_id);
    if (pending.length > 0) {
      throw new DomainError("STATE", `构件 ${component.component_id} 存在待决处置：${pending.map((d) => d.disposition_id).join("、")}`);
    }
  }

  #mustInspection(inspection) {
    if (!inspection || !inspection.inspection_id || inspection.result !== "passed" || !inspection.inspector) {
      throw new DomainError("VALIDATION", "须提交合格的检验记录（inspection_id/result=passed/inspector）");
    }
  }

  #resolvedAfter(componentId, since) {
    return [...this.#projection.dispositions.values()].some(
      (d) => d.component_id === componentId && d.status === "resolved" && d.resolved_at > since,
    );
  }

  // ---------- 查询：待决处置与构件反查 ----------

  pendingDispositions() {
    return structuredClone([...this.#projection.dispositions.values()].filter((d) => d.status === "pending"));
  }

  claimView(claimId) {
    return structuredClone(this.#mustClaim(claimId));
  }

  designView(designId) {
    const design = this.#projection.designs.get(designId);
    if (!design) throw new DomainError("NOT_FOUND", `设计不存在：${designId}`);
    return structuredClone(design);
  }

  componentView(componentId) {
    return structuredClone(this.#mustComponent(componentId));
  }

  batchView(batchId) {
    const batch = this.#projection.batches.get(batchId);
    if (!batch) throw new DomainError("NOT_FOUND", `批次不存在：${batchId}`);
    return structuredClone(batch);
  }

  /** 构件反查：采用的主张、设计决策、材料证据、放行版本与全部追加记录。 */
  traceComponent(componentId) {
    const component = this.#mustComponent(componentId);
    const design = this.#mustDesignVersion(component.design_id, component.design_version);
    const batch = this.#projection.batches.get(component.batch_id);
    return structuredClone({
      component: {
        component_id: component.component_id,
        component_type: component.component_type,
        design_id: component.design_id,
        design_version: component.design_version,
        batch_id: component.batch_id,
        stage: component.stage,
        work_state: component.work_state,
        replaces: component.replaces,
        replaced_by: component.replaced_by,
      },
      claims: design.claim_refs.map((ref) => {
        const claim = this.#projection.claims.get(ref.claim_id);
        return {
          ...ref,
          kind: claim?.kind ?? null,
          statement: claim?.versions.get(ref.claim_version)?.statement ?? null,
          status: claim?.versions.get(ref.claim_version)?.status ?? null,
        };
      }),
      design_decisions: { status: design.status, reviews: design.reviews, opinions: design.opinions },
      material_evidence: batch
        ? { batch_id: batch.batch_id, material: batch.material, invalidated: batch.invalidated, tests: batch.tests }
        : null,
      inspections: component.inspections,
      releases: this.#projection.releases.get(componentId) ?? [],
      dispositions: [...this.#projection.dispositions.values()].filter((d) => d.component_id === componentId),
      freezes: component.freezes,
      quarantines: component.quarantines,
      corrections: component.corrections,
    });
  }
}
