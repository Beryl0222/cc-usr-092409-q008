import assert from "node:assert/strict";
import test from "node:test";

import { HISTORICAL_LEAD, STRUCTURAL_LEAD } from "../src/service.js";
import { makeService, seedWorld } from "./helpers.js";

// 场景二：主张分叉——旧版本作为并行解释分支仍有效，引用它的构件不冻结；
// 专家意见严格绑定版本，不能作用于另一分支。
test("主张分叉：旧分支有效不停工，专家意见不可跨版本作用", () => {
  const harness = makeService();
  const { service } = harness;
  seedWorld(service);

  const fork = service.correctClaim({
    claim_id: "C-mood",
    new_statement: "艺术推断（备选分支）：人物乙呈沉思姿态",
    reason: "对神态存在第二种解释，保留两版并行",
    mode: "fork",
  });
  assert.equal(fork.new_version, 2);
  assert.deepEqual(fork.hold_ids, []);

  // 浮雕引用 v1 分支：不冻结、不产生处置单、门禁对该主张不报警。
  const relief = service.traceComponent("relief");
  assert.equal(relief.component.frozen, false);
  assert.equal(service.listOpenHolds().length, 0);
  const citedMood = relief.claims.find((c) => c.claim_id === "C-mood");
  assert.equal(citedMood.cited_version, 1);
  assert.equal(citedMood.cited_version_status, "active");
  assert.equal(citedMood.current_version, 2);

  // 沿新分支的设计可以采纳新分支意见；旧分支意见不能被新分支设计采纳。
  service.recordOpinion({
    opinion_id: "O-mood-v1",
    claim_id: "C-mood",
    claim_version: 1,
    expert: "艺术评论李顾问",
    conclusion: "恭敬聆听与档案语境吻合",
  });
  service.recordOpinion({
    opinion_id: "O-mood-v2",
    claim_id: "C-mood",
    claim_version: 2,
    expert: "艺术评论李顾问",
    conclusion: "沉思姿态更符合新发现的构图草稿",
  });

  assert.throws(
    () =>
      service.submitDesign({
        design_id: "D-relief",
        component_id: "relief",
        expected_version: 1,
        citations: [{ claim_id: "C-relation", claim_version: 1 }, { claim_id: "C-mood", claim_version: 2 }],
        allowed_depiction: { permitted: ["沉思姿态"], prohibited: ["敌对姿态"] },
        content_text: "浮雕方案 v2：采用神态新分支，并错误引用旧分支意见",
        // 设计引用 mood v2，却带入绑定 v1 的意见：越权作用，拒绝。
        opinion_ids: ["O-mood-v1"],
      }),
    /专家意见只能作用于其对应的主张版本/,
  );

  // 版本匹配时正常提交。
  const v2 = service.submitDesign({
    design_id: "D-relief",
    component_id: "relief",
    expected_version: 1,
    citations: [
      { claim_id: "C-relation", claim_version: 1 },
      { claim_id: "C-mood", claim_version: 2 },
    ],
    allowed_depiction: { permitted: ["侧身立像", "师生并立", "沉思姿态"], prohibited: ["正面戎装像", "敌对姿态"] },
    content_text: "浮雕方案 v2：采用神态新分支",
    opinion_ids: ["O-mood-v2"],
  });
  assert.equal(v2.version, 2);

  // 反向同样禁止：铭牌设计未引用 C-mood，却夹带属于 C-mood@v2 的意见，越权拦截。
  assert.throws(
    () =>
      service.submitDesign({
        design_id: "D-plaque",
        component_id: "plaque",
        expected_version: 1,
        citations: [{ claim_id: "C-relation", claim_version: 1 }],
        allowed_depiction: { permitted: ["师长称谓铭文"], prohibited: ["虚构履历铭文"] },
        content_text: "铭牌 v2：夹带不属于引用版本的神态意见",
        opinion_ids: ["O-mood-v2"],
      }),
    /专家意见只能作用于其对应的主张版本/,
  );

  harness.cleanup();
});

// 分叉之后再以修订方式收敛：被取代的分支触发正常传播处置。
test("分叉分支被修订取代时，引用该分支的构件照常收到处置单", () => {
  const harness = makeService();
  const { service } = harness;
  seedWorld(service);

  service.correctClaim({
    claim_id: "C-mood",
    new_statement: "神态备选：沉思",
    reason: "并行分支",
    mode: "fork",
  });
  // 浮雕仍引用 C-mood v1 分支；随后关系主张以修订方式被 v2 取代，照常驱动浮雕/铭牌停工。
  const revised = service.correctClaim({
    claim_id: "C-relation",
    new_statement: "人物甲为人物乙的同僚",
    reason: "史料修正，分叉讨论不影响关系结论",
    mode: "revise",
  });
  assert.equal(revised.hold_ids.length, 2);
  const reliefHold = service.listOpenHolds().find((h) => h.component_id === "relief");
  assert.equal(reliefHold.from_version, 1);
  assert.equal(reliefHold.to_version, 2);

  // 先提交引用 relation v2 的返工设计，再由两位负责人一致签认。
  service.submitDesign({
    design_id: "D-relief",
    component_id: "relief",
    expected_version: 1,
    citations: [
      { claim_id: "C-relation", claim_version: 2 },
      { claim_id: "C-mood", claim_version: 1 },
    ],
    allowed_depiction: { permitted: ["同僚并立"], prohibited: ["师长称谓"] },
    content_text: "浮雕 v2：同僚关系",
    opinion_ids: [],
  });
  service.confirmDisposition({
    hold_id: reliefHold.hold_id,
    role: HISTORICAL_LEAD,
    decision: "rework",
    decided_by: "史实负责人",
    new_design_version: 2,
  });
  assert.throws(
    () =>
      service.confirmDisposition({
        hold_id: reliefHold.hold_id,
        role: STRUCTURAL_LEAD,
        decision: "continue",
        decided_by: "结构负责人",
      }),
    /不一致/,
  );
  // 结构负责人改为与史实一致后闭环。
  const resolved = service.confirmDisposition({
    hold_id: reliefHold.hold_id,
    role: STRUCTURAL_LEAD,
    decision: "rework",
    decided_by: "结构负责人",
    new_design_version: 2,
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.outcome, "rework");

  harness.cleanup();
});
