import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyModelPolicyFilter,
  buildRequirementVector
} from "../uok/model-policy.js";
import {
  registerToolCompatibility,
  resetToolCompatibilityRegistry
} from "@gsd/pi-coding-agent";
test.afterEach(() => {
  resetToolCompatibilityRegistry();
});
test("uok model policy builds requirement vectors from unit metadata", () => {
  const requirements = buildRequirementVector("execute-task", {
    tags: ["docs"],
    fileCount: 8,
    estimatedLines: 600
  });
  assert.equal(requirements.instruction, 0.9);
  assert.equal(requirements.coding, 0.3);
  assert.equal(requirements.speed, 0.7);
});
test("uok model policy enforces provider/api/tool constraints and emits decision audit events", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-model-policy-"));
  try {
    mkdirSync(join(basePath, ".gsd"), { recursive: true });
    registerToolCompatibility("screenshot", { producesImages: true });
    const result = applyModelPolicyFilter(
      [
        { id: "openai-image", provider: "openai", api: "openai-responses" },
        { id: "anthropic-ok", provider: "anthropic", api: "anthropic-messages" },
        { id: "gemini-api-deny", provider: "google", api: "google-generative-ai" },
        { id: "blocked-provider", provider: "blocked", api: "anthropic-messages" }
      ],
      {
        basePath,
        traceId: "trace-model-policy-1",
        turnId: "turn-model-policy-1",
        unitType: "execute-task",
        taskMetadata: { tags: ["docs"] },
        allowCrossProvider: true,
        requiredTools: ["screenshot"],
        allowedApis: ["anthropic-messages", "openai-responses"],
        deniedProviders: ["blocked"]
      }
    );
    assert.deepEqual(
      result.eligible.map((m) => m.id),
      ["anthropic-ok"],
      "only the policy-compliant anthropic model should remain eligible"
    );
    assert.equal(result.decisions.length, 4);
    assert.equal(result.decisions[0]?.allowed, false);
    assert.match(result.decisions[0]?.reason ?? "", /tool policy denied/);
    assert.equal(result.decisions[1]?.allowed, true);
    assert.equal(result.decisions[2]?.allowed, false);
    assert.match(result.decisions[2]?.reason ?? "", /transport\/api denied by policy/);
    assert.equal(result.decisions[3]?.allowed, false);
    assert.match(result.decisions[3]?.reason ?? "", /provider denied by policy/);
    const auditLogPath = join(basePath, ".gsd", "audit", "events.jsonl");
    const auditLines = readFileSync(auditLogPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    const decisionTypes = auditLines.map((event) => event.type);
    assert.equal(auditLines.length, 4);
    assert.ok(decisionTypes.includes("model-policy-allow"));
    assert.ok(decisionTypes.includes("model-policy-deny"));
    assert.ok(
      auditLines.some((event) => (event.payload?.reason ?? "").includes("tool policy denied")),
      "audit stream should include explicit deny reasons"
    );
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy91b2stbW9kZWwtcG9saWN5LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7XG4gIGFwcGx5TW9kZWxQb2xpY3lGaWx0ZXIsXG4gIGJ1aWxkUmVxdWlyZW1lbnRWZWN0b3IsXG59IGZyb20gXCIuLi91b2svbW9kZWwtcG9saWN5LnRzXCI7XG5pbXBvcnQge1xuICByZWdpc3RlclRvb2xDb21wYXRpYmlsaXR5LFxuICByZXNldFRvb2xDb21wYXRpYmlsaXR5UmVnaXN0cnksXG59IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuXG50ZXN0LmFmdGVyRWFjaCgoKSA9PiB7XG4gIHJlc2V0VG9vbENvbXBhdGliaWxpdHlSZWdpc3RyeSgpO1xufSk7XG5cbnRlc3QoXCJ1b2sgbW9kZWwgcG9saWN5IGJ1aWxkcyByZXF1aXJlbWVudCB2ZWN0b3JzIGZyb20gdW5pdCBtZXRhZGF0YVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlcXVpcmVtZW50cyA9IGJ1aWxkUmVxdWlyZW1lbnRWZWN0b3IoXCJleGVjdXRlLXRhc2tcIiwge1xuICAgIHRhZ3M6IFtcImRvY3NcIl0sXG4gICAgZmlsZUNvdW50OiA4LFxuICAgIGVzdGltYXRlZExpbmVzOiA2MDAsXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChyZXF1aXJlbWVudHMuaW5zdHJ1Y3Rpb24sIDAuOSk7XG4gIGFzc2VydC5lcXVhbChyZXF1aXJlbWVudHMuY29kaW5nLCAwLjMpO1xuICBhc3NlcnQuZXF1YWwocmVxdWlyZW1lbnRzLnNwZWVkLCAwLjcpO1xufSk7XG5cbnRlc3QoXCJ1b2sgbW9kZWwgcG9saWN5IGVuZm9yY2VzIHByb3ZpZGVyL2FwaS90b29sIGNvbnN0cmFpbnRzIGFuZCBlbWl0cyBkZWNpc2lvbiBhdWRpdCBldmVudHNcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlUGF0aCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXVvay1tb2RlbC1wb2xpY3ktXCIpKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICByZWdpc3RlclRvb2xDb21wYXRpYmlsaXR5KFwic2NyZWVuc2hvdFwiLCB7IHByb2R1Y2VzSW1hZ2VzOiB0cnVlIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXBwbHlNb2RlbFBvbGljeUZpbHRlcihcbiAgICAgIFtcbiAgICAgICAgeyBpZDogXCJvcGVuYWktaW1hZ2VcIiwgcHJvdmlkZXI6IFwib3BlbmFpXCIsIGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIgfSxcbiAgICAgICAgeyBpZDogXCJhbnRocm9waWMtb2tcIiwgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9LFxuICAgICAgICB7IGlkOiBcImdlbWluaS1hcGktZGVueVwiLCBwcm92aWRlcjogXCJnb29nbGVcIiwgYXBpOiBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIgfSxcbiAgICAgICAgeyBpZDogXCJibG9ja2VkLXByb3ZpZGVyXCIsIHByb3ZpZGVyOiBcImJsb2NrZWRcIiwgYXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiIH0sXG4gICAgICBdLFxuICAgICAge1xuICAgICAgICBiYXNlUGF0aCxcbiAgICAgICAgdHJhY2VJZDogXCJ0cmFjZS1tb2RlbC1wb2xpY3ktMVwiLFxuICAgICAgICB0dXJuSWQ6IFwidHVybi1tb2RlbC1wb2xpY3ktMVwiLFxuICAgICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgICAgdGFza01ldGFkYXRhOiB7IHRhZ3M6IFtcImRvY3NcIl0gfSxcbiAgICAgICAgYWxsb3dDcm9zc1Byb3ZpZGVyOiB0cnVlLFxuICAgICAgICByZXF1aXJlZFRvb2xzOiBbXCJzY3JlZW5zaG90XCJdLFxuICAgICAgICBhbGxvd2VkQXBpczogW1wiYW50aHJvcGljLW1lc3NhZ2VzXCIsIFwib3BlbmFpLXJlc3BvbnNlc1wiXSxcbiAgICAgICAgZGVuaWVkUHJvdmlkZXJzOiBbXCJibG9ja2VkXCJdLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIHJlc3VsdC5lbGlnaWJsZS5tYXAoKG0pID0+IG0uaWQpLFxuICAgICAgW1wiYW50aHJvcGljLW9rXCJdLFxuICAgICAgXCJvbmx5IHRoZSBwb2xpY3ktY29tcGxpYW50IGFudGhyb3BpYyBtb2RlbCBzaG91bGQgcmVtYWluIGVsaWdpYmxlXCIsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRlY2lzaW9ucy5sZW5ndGgsIDQpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGVjaXNpb25zWzBdPy5hbGxvd2VkLCBmYWxzZSk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5kZWNpc2lvbnNbMF0/LnJlYXNvbiA/PyBcIlwiLCAvdG9vbCBwb2xpY3kgZGVuaWVkLyk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZWNpc2lvbnNbMV0/LmFsbG93ZWQsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZGVjaXNpb25zWzJdPy5hbGxvd2VkLCBmYWxzZSk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5kZWNpc2lvbnNbMl0/LnJlYXNvbiA/PyBcIlwiLCAvdHJhbnNwb3J0XFwvYXBpIGRlbmllZCBieSBwb2xpY3kvKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRlY2lzaW9uc1szXT8uYWxsb3dlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuZGVjaXNpb25zWzNdPy5yZWFzb24gPz8gXCJcIiwgL3Byb3ZpZGVyIGRlbmllZCBieSBwb2xpY3kvKTtcblxuICAgIGNvbnN0IGF1ZGl0TG9nUGF0aCA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcImF1ZGl0XCIsIFwiZXZlbnRzLmpzb25sXCIpO1xuICAgIGNvbnN0IGF1ZGl0TGluZXMgPSByZWFkRmlsZVN5bmMoYXVkaXRMb2dQYXRoLCBcInV0Zi04XCIpXG4gICAgICAudHJpbSgpXG4gICAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAgIC5tYXAoKGxpbmUpID0+IEpTT04ucGFyc2UobGluZSkgYXMgeyB0eXBlOiBzdHJpbmc7IHBheWxvYWQ/OiB7IHJlYXNvbj86IHN0cmluZyB9IH0pO1xuICAgIGNvbnN0IGRlY2lzaW9uVHlwZXMgPSBhdWRpdExpbmVzLm1hcCgoZXZlbnQpID0+IGV2ZW50LnR5cGUpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGF1ZGl0TGluZXMubGVuZ3RoLCA0KTtcbiAgICBhc3NlcnQub2soZGVjaXNpb25UeXBlcy5pbmNsdWRlcyhcIm1vZGVsLXBvbGljeS1hbGxvd1wiKSk7XG4gICAgYXNzZXJ0Lm9rKGRlY2lzaW9uVHlwZXMuaW5jbHVkZXMoXCJtb2RlbC1wb2xpY3ktZGVueVwiKSk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgYXVkaXRMaW5lcy5zb21lKChldmVudCkgPT4gKGV2ZW50LnBheWxvYWQ/LnJlYXNvbiA/PyBcIlwiKS5pbmNsdWRlcyhcInRvb2wgcG9saWN5IGRlbmllZFwiKSksXG4gICAgICBcImF1ZGl0IHN0cmVhbSBzaG91bGQgaW5jbHVkZSBleHBsaWNpdCBkZW55IHJlYXNvbnNcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlUGF0aCwgeyBy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
