import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStore } from "../src/event-store.js";
import { PropagationService } from "../src/service.js";

/** 单调递增时钟：保证检验/返工/放行时间先后可比较。 */
export function makeClock(start = "2026-09-20T08:00:00+08:00") {
  let minutes = 0;
  const base = Date.parse(start);
  return () => new Date(base + minutes++ * 60_000).toISOString();
}

export function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "sculpture-"));
  const file = join(dir, "events.jsonl");
  const service = new PropagationService(new EventStore(file), makeClock());
  return {
    service,
    file,
    reopen() {
      return new PropagationService(new EventStore(file), makeClock("2026-09-25T08:00:00+08:00"));
    },
    eventCount() {
      const raw = readFileSync(file, "utf8");
      return raw.split("\n").filter((l) => l.trim()).length;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 构造加工中的纪念雕塑现场：
 * 浮雕与铭牌引用人物关系主张，底座为结构构件不引用任何主张；
 * 铭牌已制造完成，浮雕与底座在产；浮雕/铭牌共用青铜批次，底座用花岗岩批次。
 */
export function seedWorld(service) {
  service.submitClaim({
    claim_id: "C-relation",
    kind: "historical_evidence",
    subject: "人物关系",
    statement: "人物甲为人物乙的师长（据档案记载）",
  });
  service.submitClaim({
    claim_id: "C-mood",
    kind: "artistic_inference",
    subject: "人物神态",
    statement: "艺术推断：人物乙呈恭敬聆听姿态",
  });

  service.registerComponent({ component_id: "relief", name: "东侧人物浮雕", discipline: "art" });
  service.registerComponent({ component_id: "plaque", name: "说明铭牌", discipline: "art" });
  service.registerComponent({ component_id: "plinth", name: "钢筋混凝土底座", discipline: "structure" });

  service.registerBatch({ batch_id: "B-bronze", material: "青铜" });
  service.registerBatch({ batch_id: "B-granite", material: "花岗岩" });

  service.submitDesign({
    design_id: "D-relief",
    component_id: "relief",
    citations: [
      { claim_id: "C-relation", claim_version: 1 },
      { claim_id: "C-mood", claim_version: 1 },
    ],
    allowed_depiction: {
      permitted: ["侧身立像", "师生并立", "恭敬聆听姿态"],
      prohibited: ["正面戎装像", "敌对姿态"],
    },
    content_text: "浮雕方案 v1：师长侧身，弟子恭敬聆听",
    opinion_ids: [],
  });
  service.submitDesign({
    design_id: "D-plaque",
    component_id: "plaque",
    citations: [{ claim_id: "C-relation", claim_version: 1 }],
    allowed_depiction: { permitted: ["师长称谓铭文"], prohibited: ["虚构履历铭文"] },
    content_text: "铭牌 v1：载明年长人物为弟子之师",
    opinion_ids: [],
  });
  service.submitDesign({
    design_id: "D-plinth",
    component_id: "plinth",
    citations: [],
    allowed_depiction: { permitted: ["素面混凝土", "结构配筋示意"], prohibited: ["人物刻画"] },
    content_text: "底座结构图 v1",
    opinion_ids: [],
  });

  service.recordDesignDecision({
    design_id: "D-relief",
    decision_id: "DD-layout-1",
    decision: "人物站位采用师生并立构图",
    decided_by: "艺术负责人",
  });

  service.recordOpinion({
    opinion_id: "O-relation-v1",
    claim_id: "C-relation",
    claim_version: 1,
    expert: "史学金教授",
    conclusion: "档案链完整，支持师长关系",
  });

  service.assignBatch({ component_id: "relief", batch_id: "B-bronze" });
  service.assignBatch({ component_id: "plaque", batch_id: "B-bronze" });
  service.assignBatch({ component_id: "plinth", batch_id: "B-granite" });

  service.issueWorkOrder({ component_id: "relief" });
  service.issueWorkOrder({ component_id: "plaque" });
  service.issueWorkOrder({ component_id: "plinth" });

  service.recordInspection({ component_id: "relief", inspection_id: "I-relief-m", stage: "material", result: "pass", note: "铜材复验合格" });
  service.recordInspection({ component_id: "plaque", inspection_id: "I-plaque-m", stage: "material", result: "pass", note: "铜材复验合格" });
  service.recordInspection({ component_id: "plaque", inspection_id: "I-plaque-f", stage: "final", result: "pass", note: "铭牌成品检验合格" });
  service.recordInspection({ component_id: "plinth", inspection_id: "I-plinth-m", stage: "material", result: "pass", note: "花岗岩复验合格" });
  service.recordInspection({ component_id: "plinth", inspection_id: "I-plinth-f", stage: "final", result: "pass", note: "底座成品检验合格" });

  return {
    claims: { relation: "C-relation", mood: "C-mood" },
    components: { relief: "relief", plaque: "plaque", plinth: "plinth" },
    designs: { relief: "D-relief", plaque: "D-plaque", plinth: "D-plinth" },
    batches: { bronze: "B-bronze", granite: "B-granite" },
  };
}
