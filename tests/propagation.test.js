import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SculptureReviewService } from "../src/service.js";
import { validateEvent } from "../src/validator.js";

const historian = { id: "shishi-01", role: "historical_lead" };
const structural = { id: "jiegou-01", role: "structural_lead" };
const expert = { id: "expert-01", role: "expert" };
// 总师同时承担设计提交与审查职责
const chiefActor = { id: "zongshi-01", role: "chief" };

const inspect = (id) => ({ inspection_id: id, result: "passed", inspector: "jianyan-01" });

/** 纪念性雕塑标准现场：人物关系证据、场景推断、浮雕/铭牌/底座三项设计与构件。 */
function seedWorkshop() {
  const service = new SculptureReviewService();
  service.submitClaim({ command_id: "c-claim-relation", actor: historian, claim_id: "claim-relation", kind: "evidence", statement: "甲为乙之弟子" });
  service.submitClaim({ command_id: "c-claim-scene", actor: historian, claim_id: "claim-scene", kind: "inference", statement: "画面构图为江边送别" });
  service.submitDesign({
    command_id: "c-design-relief",
    actor: chiefActor,
    design_id: "design-relief",
    baseline_version: 0,
    claim_refs: [
      { claim_id: "claim-relation", claim_version: 1, representation_scope: "人物形象与相互关系" },
      { claim_id: "claim-scene", claim_version: 1, representation_scope: "场景构图" },
    ],
  });
  service.submitDesign({
    command_id: "c-design-plaque",
    actor: chiefActor,
    design_id: "design-plaque",
    baseline_version: 0,
    claim_refs: [{ claim_id: "claim-relation", claim_version: 1, representation_scope: "铭文称谓" }],
  });
  service.submitDesign({ command_id: "c-design-pedestal", actor: chiefActor, design_id: "design-pedestal", baseline_version: 0, claim_refs: [] });
  service.reviewDesign({ command_id: "c-review-relief", actor: chiefActor, design_id: "design-relief", design_version: 1, decision: "approved" });
  service.reviewDesign({ command_id: "c-review-plaque", actor: chiefActor, design_id: "design-plaque", design_version: 1, decision: "approved" });
  service.reviewDesign({ command_id: "c-review-pedestal", actor: chiefActor, design_id: "design-pedestal", design_version: 1, decision: "approved" });
  service.registerBatch({ command_id: "c-batch-bronze", actor: structural, batch_id: "batch-bronze", material: "青铜" });
  service.registerBatch({ command_id: "c-batch-stone", actor: structural, batch_id: "batch-stone", material: "石材" });
  service.recordMaterialTest({ command_id: "c-test-bronze", actor: structural, batch_id: "batch-bronze", test_id: "t-bronze-1", result: "passed" });
  service.recordMaterialTest({ command_id: "c-test-stone", actor: structural, batch_id: "batch-stone", test_id: "t-stone-1", result: "passed" });
  service.registerComponent({ command_id: "c-comp-relief", actor: chiefActor, component_id: "comp-relief", component_type: "浮雕", design_id: "design-relief", design_version: 1, batch_id: "batch-bronze" });
  service.registerComponent({ command_id: "c-comp-plaque", actor: chiefActor, component_id: "comp-plaque", component_type: "铭牌", design_id: "design-plaque", design_version: 1, batch_id: "batch-bronze" });
  service.registerComponent({ command_id: "c-comp-pedestal", actor: chiefActor, component_id: "comp-pedestal", component_type: "底座", design_id: "design-pedestal", design_version: 1, batch_id: "batch-stone" });
  for (const id of ["comp-relief", "comp-plaque", "comp-pedestal"]) {
    service.advanceComponentStage({ command_id: `c-fab-${id}`, actor: chiefActor, component_id: id, to_stage: "in_fabrication" });
  }
  return service;
}

const pendingOf = (service, componentId) => service.pendingDispositions().filter((d) => d.component_id === componentId);

test("局部停工：主张更正只冻结引用该主张的浮雕与铭牌，底座不被一并冻结", () => {
  const service = seedWorkshop();
  const result = service.correctClaim({
    command_id: "c-correct-1",
    actor: historian,
    claim_id: "claim-relation",
    base_version: 1,
    statement: "甲为乙之同僚而非弟子",
    reason: "史料委员会修正人物关系",
  });
  assert.deepEqual(result.affected_components.sort(), ["comp-plaque", "comp-relief"]);

  assert.equal(service.componentView("comp-relief").work_state, "frozen");
  assert.equal(service.componentView("comp-plaque").work_state, "frozen");
  assert.equal(service.componentView("comp-pedestal").work_state, "active");

  const pending = service.pendingDispositions();
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map((d) => d.required_roles), [["historical_lead"], ["historical_lead"]]);

  // 底座不停工，可继续加工
  service.advanceComponentStage({ command_id: "c-pedestal-fab", actor: chiefActor, component_id: "comp-pedestal", to_stage: "fabricated", inspection: inspect("I-PED-1") });
  assert.equal(service.componentView("comp-pedestal").stage, "fabricated");

  // 停工构件禁止推进
  assert.throws(
    () => service.advanceComponentStage({ command_id: "c-relief-fab", actor: chiefActor, component_id: "comp-relief", to_stage: "fabricated", inspection: inspect("I-R-1") }),
    (error) => error.code === "STATE",
  );
});

test("主张分叉：更正后新旧版本并存，只波及引用旧版本的构件，专家意见不串版本", () => {
  const service = seedWorkshop();
  service.correctClaim({ command_id: "c-correct-1", actor: historian, claim_id: "claim-relation", base_version: 1, statement: "甲为乙之同僚", reason: "修正" });

  // 新设计版本引用更正后的主张 v2，登记的新构件不受影响
  service.submitDesign({
    command_id: "c-design-relief-2",
    actor: chiefActor,
    design_id: "design-relief",
    baseline_version: 1,
    claim_refs: [{ claim_id: "claim-relation", claim_version: 2, representation_scope: "人物形象与相互关系" }],
  });
  service.reviewDesign({ command_id: "c-review-relief-2", actor: chiefActor, design_id: "design-relief", design_version: 2, decision: "approved" });
  service.registerComponent({ command_id: "c-comp-relief-b", actor: chiefActor, component_id: "comp-relief-b", component_type: "浮雕", design_id: "design-relief", design_version: 2, batch_id: "batch-bronze" });
  service.advanceComponentStage({ command_id: "c-fab-relief-b", actor: chiefActor, component_id: "comp-relief-b", to_stage: "in_fabrication" });
  assert.equal(service.componentView("comp-relief-b").work_state, "active");
  assert.equal(service.componentView("comp-relief").work_state, "frozen");

  // 专家意见只作用于指定版本
  service.recordExpertOpinion({ command_id: "c-op-1", actor: expert, design_id: "design-relief", design_version: 1, opinion: "衣纹处理需再考证" });
  const design = service.designView("design-relief");
  assert.equal(design.versions.get(1).opinions.length, 1);
  assert.equal(design.versions.get(2).opinions.length, 0);
  assert.throws(
    () => service.recordExpertOpinion({ command_id: "c-op-2", actor: expert, design_id: "design-relief", design_version: 99, opinion: "无的放矢" }),
    (error) => error.code === "NOT_FOUND",
  );
});

test("史实证据与艺术推断分开版本化：更正推断不影响证据的版本链", () => {
  const service = seedWorkshop();
  service.correctClaim({ command_id: "c-correct-scene", actor: historian, claim_id: "claim-scene", base_version: 1, statement: "画面构图为渡口送行", reason: "推断修订" });

  const scene = service.claimView("claim-scene");
  assert.equal(scene.latest_version, 2);
  assert.equal(scene.versions.get(1).status, "superseded");
  assert.equal(scene.versions.get(2).status, "active");

  const relation = service.claimView("claim-relation");
  assert.equal(relation.latest_version, 1);
  assert.equal(relation.versions.get(1).status, "active");
});

test("批次失效：材料试验失败沿批次关联传播，结构负责人按职责确认", () => {
  const service = seedWorkshop();
  service.advanceComponentStage({ command_id: "c-relief-fab", actor: chiefActor, component_id: "comp-relief", to_stage: "fabricated", inspection: inspect("I-R-1") });

  const result = service.recordMaterialTest({ command_id: "c-test-bronze-2", actor: structural, batch_id: "batch-bronze", test_id: "t-bronze-2", result: "failed", summary: "青铜批次光谱复验不合格" });
  assert.deepEqual(result.affected_components.sort(), ["comp-plaque", "comp-relief"]);

  // 已制造的隔离、未制造完成的停工；石材批次构件不受影响
  assert.equal(service.componentView("comp-relief").work_state, "quarantined");
  assert.equal(service.componentView("comp-plaque").work_state, "frozen");
  assert.equal(service.componentView("comp-pedestal").work_state, "active");
  assert.equal(service.batchView("batch-bronze").invalidated, true);
  assert.equal(service.batchView("batch-stone").invalidated, false);

  const [reliefDisp] = pendingOf(service, "comp-relief");
  assert.deepEqual(reliefDisp.required_roles, ["structural_lead"]);

  // 史实负责人无权确认批次处置
  assert.throws(
    () => service.confirmDisposition({ command_id: "c-conf-wrong", actor: historian, disposition_id: reliefDisp.disposition_id, decision: "continue" }),
    (error) => error.code === "ROLE",
  );

  // 结构负责人确认替换已制造构件、继续排查中构件
  const resolved = service.confirmDisposition({ command_id: "c-conf-relief", actor: structural, disposition_id: reliefDisp.disposition_id, decision: "replace", note: "青铜铸件报废" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.action, "replace");
  assert.equal(service.componentView("comp-relief").work_state, "replaced");

  const [plaqueDisp] = pendingOf(service, "comp-plaque");
  service.confirmDisposition({ command_id: "c-conf-plaque", actor: structural, disposition_id: plaqueDisp.disposition_id, decision: "continue", note: "铭牌尚未浇铸，改用新批次" });
  assert.equal(service.componentView("comp-plaque").work_state, "active");

  // 原检验记录保持原样，纠正只以追加记录体现
  const trace = service.traceComponent("comp-relief");
  assert.deepEqual(trace.inspections, [inspect("I-R-1")]);
  assert.equal(trace.corrections.length, 1);
  assert.equal(trace.corrections[0].action, "replace");

  // 失效批次不能再用于新构件，试验记录不可改写
  assert.throws(
    () => service.registerComponent({ command_id: "c-comp-x", actor: chiefActor, component_id: "comp-x", component_type: "浮雕", design_id: "design-relief", design_version: 1, batch_id: "batch-bronze" }),
    (error) => error.code === "STATE",
  );
  assert.throws(
    () => service.recordMaterialTest({ command_id: "c-test-dup", actor: structural, batch_id: "batch-bronze", test_id: "t-bronze-2", result: "passed" }),
    (error) => error.code === "CONFLICT",
  );
});

test("更正后重新放行：修正主张 → 修订设计 → 确认处置 → 再次放行生成新放行版本", () => {
  const service = seedWorkshop();
  service.correctClaim({ command_id: "c-correct-1", actor: historian, claim_id: "claim-relation", base_version: 1, statement: "甲为乙之同僚", reason: "第一次修正" });

  // 铭牌设计修订到主张 v2，构件改派后由史实负责人确认继续
  service.submitDesign({ command_id: "c-design-plaque-2", actor: chiefActor, design_id: "design-plaque", baseline_version: 1, claim_refs: [{ claim_id: "claim-relation", claim_version: 2, representation_scope: "铭文称谓" }] });
  service.reviewDesign({ command_id: "c-review-plaque-2", actor: chiefActor, design_id: "design-plaque", design_version: 2, decision: "approved" });
  service.reassignComponentDesign({ command_id: "c-reassign-plaque", actor: chiefActor, component_id: "comp-plaque", design_id: "design-plaque", design_version: 2, reason: "铭文改用更正后称谓" });
  const [disp1] = pendingOf(service, "comp-plaque");
  service.confirmDisposition({ command_id: "c-conf-plaque-1", actor: historian, disposition_id: disp1.disposition_id, decision: "continue", note: "按新铭文继续" });
  assert.equal(service.componentView("comp-plaque").work_state, "active");

  // 首次放行
  service.advanceComponentStage({ command_id: "c-plaque-fab", actor: chiefActor, component_id: "comp-plaque", to_stage: "fabricated", inspection: inspect("I-PL-1") });
  const first = service.requestInstallation({ command_id: "c-install-1", actor: chiefActor, component_id: "comp-plaque", inspection: inspect("I-PL-2") });
  assert.equal(first.release_version, 1);
  assert.equal(service.componentView("comp-plaque").stage, "installed");

  // 主张再次更正：已安装构件只追加隔离记录，门禁拒绝放行
  service.correctClaim({ command_id: "c-correct-2", actor: historian, claim_id: "claim-relation", base_version: 2, statement: "甲为乙之同僚兼同乡", reason: "第二次修正" });
  assert.equal(service.componentView("comp-plaque").work_state, "quarantined");
  assert.throws(
    () => service.requestInstallation({ command_id: "c-install-2", actor: chiefActor, component_id: "comp-plaque" }),
    (error) => error.code === "GATE",
  );

  // 修订设计到主张 v3，确认处置后重新放行
  service.submitDesign({ command_id: "c-design-plaque-3", actor: chiefActor, design_id: "design-plaque", baseline_version: 2, claim_refs: [{ claim_id: "claim-relation", claim_version: 3, representation_scope: "铭文称谓" }] });
  service.reviewDesign({ command_id: "c-review-plaque-3", actor: chiefActor, design_id: "design-plaque", design_version: 3, decision: "approved" });
  service.reassignComponentDesign({ command_id: "c-reassign-plaque-3", actor: chiefActor, component_id: "comp-plaque", design_id: "design-plaque", design_version: 3, reason: "铭文再次更正" });
  const [disp2] = pendingOf(service, "comp-plaque");
  service.confirmDisposition({ command_id: "c-conf-plaque-2", actor: historian, disposition_id: disp2.disposition_id, decision: "continue", note: "隔离解除，按 v3 铭文继续" });

  const second = service.requestInstallation({ command_id: "c-install-3", actor: chiefActor, component_id: "comp-plaque" });
  assert.equal(second.release_version, 2);

  const trace = service.traceComponent("comp-plaque");
  assert.deepEqual(trace.releases.map((r) => r.release_version), [1, 2]);
  assert.equal(trace.releases[0].claim_versions[0].claim_version, 2);
  assert.equal(trace.releases[1].claim_versions[0].claim_version, 3);
  assert.equal(trace.quarantines.length, 1);
});

test("审批重传幂等，内容变化拒绝重放", () => {
  const service = seedWorkshop();
  service.submitDesign({ command_id: "c-design-extra", actor: chiefActor, design_id: "design-extra", baseline_version: 0, claim_refs: [] });

  const before = service.events.length;
  const first = service.reviewDesign({ command_id: "c-review-extra", actor: chiefActor, design_id: "design-extra", design_version: 1, decision: "approved" });
  const during = service.events.length;
  assert.ok(during > before);

  // 同标识同内容重传：返回首次结果，不产生新事件
  const replay = service.reviewDesign({ command_id: "c-review-extra", actor: chiefActor, design_id: "design-extra", design_version: 1, decision: "approved" });
  assert.deepEqual(replay, first);
  assert.equal(service.events.length, during);

  // 同标识内容变化：拒绝重放
  assert.throws(
    () => service.reviewDesign({ command_id: "c-review-extra", actor: chiefActor, design_id: "design-extra", design_version: 1, decision: "rejected" }),
    (error) => error.code === "REPLAY_CONFLICT",
  );
  assert.equal(service.events.length, during);
});

test("并行设计提交使用基线版本防止覆盖", () => {
  const service = seedWorkshop();
  service.submitDesign({ command_id: "c-par-a", actor: chiefActor, design_id: "design-relief", baseline_version: 1, claim_refs: [{ claim_id: "claim-relation", claim_version: 1, representation_scope: "人物衣纹" }] });
  assert.throws(
    () => service.submitDesign({ command_id: "c-par-b", actor: chiefActor, design_id: "design-relief", baseline_version: 1, claim_refs: [] }),
    (error) => error.code === "CONFLICT" && /并行提交冲突/.test(error.message),
  );
  assert.equal(service.designView("design-relief").latest_version, 2);
});

test("服务恢复后继续待决处置和安装门禁", () => {
  const service = seedWorkshop();
  service.correctClaim({ command_id: "c-correct-1", actor: historian, claim_id: "claim-relation", base_version: 1, statement: "甲为乙之同僚", reason: "修正" });
  const snapshot = service.snapshot();

  const restored = SculptureReviewService.restore(snapshot);
  assert.equal(restored.pendingDispositions().length, 2);
  assert.equal(restored.componentView("comp-relief").work_state, "frozen");

  // 门禁在恢复后仍然拦截停工构件
  assert.throws(
    () => restored.requestInstallation({ command_id: "c-install-x", actor: chiefActor, component_id: "comp-relief" }),
    (error) => error.code === "GATE",
  );

  // 恢复前的指令登记仍然有效：重传返回首次结果，不产生新事件
  const eventsBefore = restored.events.length;
  const replay = restored.correctClaim({ command_id: "c-correct-1", actor: historian, claim_id: "claim-relation", base_version: 1, statement: "甲为乙之同僚", reason: "修正" });
  assert.deepEqual(replay.affected_components.sort(), ["comp-plaque", "comp-relief"]);
  assert.equal(restored.events.length, eventsBefore);

  // 待决处置在恢复后可继续确认
  const [disp] = pendingOf(restored, "comp-relief");
  restored.confirmDisposition({ command_id: "c-conf-after-restore", actor: historian, disposition_id: disp.disposition_id, decision: "continue", note: "恢复后继续办理" });
  assert.equal(restored.componentView("comp-relief").work_state, "active");
});

test("已制造构件的原检验不可改写，只能追加记录", () => {
  const service = seedWorkshop();
  service.advanceComponentStage({ command_id: "c-ped-fab", actor: chiefActor, component_id: "comp-pedestal", to_stage: "fabricated", inspection: inspect("I-PED-1") });

  // 不能重复推进到已达阶段来改写检验
  assert.throws(
    () => service.advanceComponentStage({ command_id: "c-ped-fab-2", actor: chiefActor, component_id: "comp-pedestal", to_stage: "fabricated", inspection: inspect("I-PED-99") }),
    (error) => error.code === "STATE",
  );
  // 安装只能经放行门禁
  assert.throws(
    () => service.advanceComponentStage({ command_id: "c-ped-inst", actor: chiefActor, component_id: "comp-pedestal", to_stage: "installed", inspection: inspect("I-PED-3") }),
    (error) => error.code === "VALIDATION",
  );
  assert.deepEqual(service.traceComponent("comp-pedestal").inspections, [inspect("I-PED-1")]);
});

test("构件反查：采用的主张、设计决策、材料证据和放行版本", () => {
  const service = seedWorkshop();
  service.recordExpertOpinion({ command_id: "c-op-1", actor: expert, design_id: "design-relief", design_version: 1, opinion: "人物比例可再斟酌" });
  service.advanceComponentStage({ command_id: "c-relief-fab", actor: chiefActor, component_id: "comp-relief", to_stage: "fabricated", inspection: inspect("I-R-1") });
  service.requestInstallation({ command_id: "c-install-relief", actor: chiefActor, component_id: "comp-relief", inspection: inspect("I-R-2") });

  const trace = service.traceComponent("comp-relief");
  assert.equal(trace.component.stage, "installed");
  assert.deepEqual(
    trace.claims.map((c) => [c.claim_id, c.claim_version, c.kind, c.status]),
    [
      ["claim-relation", 1, "evidence", "active"],
      ["claim-scene", 1, "inference", "active"],
    ],
  );
  assert.equal(trace.design_decisions.reviews.length, 1);
  assert.equal(trace.design_decisions.opinions.length, 1);
  assert.equal(trace.material_evidence.batch_id, "batch-bronze");
  assert.equal(trace.material_evidence.tests.length, 1);
  assert.deepEqual(trace.inspections, [inspect("I-R-1"), inspect("I-R-2")]);
  assert.deepEqual(trace.releases.map((r) => r.release_version), [1]);
});

test("服务产生的全部事件符合领域契约", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  const service = seedWorkshop();
  service.correctClaim({ command_id: "c-correct-1", actor: historian, claim_id: "claim-relation", base_version: 1, statement: "甲为乙之同僚", reason: "修正" });
  service.recordMaterialTest({ command_id: "c-test-bronze-9", actor: structural, batch_id: "batch-bronze", test_id: "t-bronze-9", result: "failed" });

  for (const event of service.events) {
    assert.deepEqual(validateEvent(event), [], `事件信封缺字段：${event.event_type}`);
    assert.ok(schema.properties.event_type.enum.includes(event.event_type), `契约未收录事件类型：${event.event_type}`);
    assert.ok(schema.properties.aggregate_type.enum.includes(event.aggregate_type), `契约未收录聚合类型：${event.aggregate_type}`);
  }
});
