import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverModels } from "../ollama-discovery.js";
const EMPTY_DETAILS = { parent_model: "", format: "", family: "", families: null, parameter_size: "", quantization_level: "" };
function modelStub(name, parameterSize = "") {
  return { name, model: name, modified_at: "", size: 0, digest: "", details: { ...EMPTY_DETAILS, parameter_size: parameterSize } };
}
function tagsStub(name, parameterSize = "") {
  return { models: [modelStub(name, parameterSize)] };
}
function showStub(modelInfo) {
  return { modelfile: "", parameters: "", template: "", details: EMPTY_DETAILS, model_info: modelInfo };
}
describe("discoverModels \u2014 context window resolution", () => {
  it("uses known table context window without calling /api/show", async () => {
    let showCalled = false;
    const models = await discoverModels({
      listModels: async () => tagsStub("llama3.2:latest", "3B"),
      showModel: async () => {
        showCalled = true;
        throw new Error("should not be called");
      }
    });
    assert.equal(models[0].contextWindow, 131072);
    assert.equal(showCalled, false);
  });
  it("uses context_length from /api/show model_info for unknown model", async () => {
    const models = await discoverModels({
      listModels: async () => tagsStub("gemini-3-flash-preview:latest"),
      showModel: async () => showStub({ "gemini.context_length": 1048576 })
    });
    assert.equal(models[0].contextWindow, 1048576);
  });
  it("falls back to 8192 when /api/show model_info has no context_length key", async () => {
    const models = await discoverModels({
      listModels: async () => tagsStub("unknown-model:latest"),
      showModel: async () => showStub({})
    });
    assert.equal(models[0].contextWindow, 8192);
  });
  it("falls back to 8192 when /api/show throws", async () => {
    const models = await discoverModels({
      listModels: async () => tagsStub("unknown-model:latest"),
      showModel: async () => {
        throw new Error("network error");
      }
    });
    assert.equal(models[0].contextWindow, 8192);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL29sbGFtYS90ZXN0cy9vbGxhbWEtZGlzY292ZXJ5LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRDIgXHUyMDE0IFRlc3RzIGZvciBPbGxhbWEgbW9kZWwgZGlzY292ZXJ5IGFuZCBlbnJpY2htZW50XG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGRpc2NvdmVyTW9kZWxzIH0gZnJvbSBcIi4uL29sbGFtYS1kaXNjb3ZlcnkuanNcIjtcbmltcG9ydCB0eXBlIHsgT2xsYW1hVGFnc1Jlc3BvbnNlLCBPbGxhbWFTaG93UmVzcG9uc2UgfSBmcm9tIFwiLi4vdHlwZXMuanNcIjtcblxuY29uc3QgRU1QVFlfREVUQUlMUyA9IHsgcGFyZW50X21vZGVsOiBcIlwiLCBmb3JtYXQ6IFwiXCIsIGZhbWlseTogXCJcIiwgZmFtaWxpZXM6IG51bGwsIHBhcmFtZXRlcl9zaXplOiBcIlwiLCBxdWFudGl6YXRpb25fbGV2ZWw6IFwiXCIgfTtcblxuZnVuY3Rpb24gbW9kZWxTdHViKG5hbWU6IHN0cmluZywgcGFyYW1ldGVyU2l6ZSA9IFwiXCIpIHtcblx0cmV0dXJuIHsgbmFtZSwgbW9kZWw6IG5hbWUsIG1vZGlmaWVkX2F0OiBcIlwiLCBzaXplOiAwLCBkaWdlc3Q6IFwiXCIsIGRldGFpbHM6IHsgLi4uRU1QVFlfREVUQUlMUywgcGFyYW1ldGVyX3NpemU6IHBhcmFtZXRlclNpemUgfSB9O1xufVxuXG5mdW5jdGlvbiB0YWdzU3R1YihuYW1lOiBzdHJpbmcsIHBhcmFtZXRlclNpemUgPSBcIlwiKTogT2xsYW1hVGFnc1Jlc3BvbnNlIHtcblx0cmV0dXJuIHsgbW9kZWxzOiBbbW9kZWxTdHViKG5hbWUsIHBhcmFtZXRlclNpemUpXSB9O1xufVxuXG5mdW5jdGlvbiBzaG93U3R1Yihtb2RlbEluZm86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogT2xsYW1hU2hvd1Jlc3BvbnNlIHtcblx0cmV0dXJuIHsgbW9kZWxmaWxlOiBcIlwiLCBwYXJhbWV0ZXJzOiBcIlwiLCB0ZW1wbGF0ZTogXCJcIiwgZGV0YWlsczogRU1QVFlfREVUQUlMUywgbW9kZWxfaW5mbzogbW9kZWxJbmZvIH07XG59XG5cbmRlc2NyaWJlKFwiZGlzY292ZXJNb2RlbHMgXHUyMDE0IGNvbnRleHQgd2luZG93IHJlc29sdXRpb25cIiwgKCkgPT4ge1xuXHRpdChcInVzZXMga25vd24gdGFibGUgY29udGV4dCB3aW5kb3cgd2l0aG91dCBjYWxsaW5nIC9hcGkvc2hvd1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0bGV0IHNob3dDYWxsZWQgPSBmYWxzZTtcblx0XHRjb25zdCBtb2RlbHMgPSBhd2FpdCBkaXNjb3Zlck1vZGVscyh7XG5cdFx0XHRsaXN0TW9kZWxzOiBhc3luYyAoKSA9PiB0YWdzU3R1YihcImxsYW1hMy4yOmxhdGVzdFwiLCBcIjNCXCIpLFxuXHRcdFx0c2hvd01vZGVsOiBhc3luYyAoKSA9PiB7IHNob3dDYWxsZWQgPSB0cnVlOyB0aHJvdyBuZXcgRXJyb3IoXCJzaG91bGQgbm90IGJlIGNhbGxlZFwiKTsgfSxcblx0XHR9KTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWxzWzBdLmNvbnRleHRXaW5kb3csIDEzMTA3Mik7XG5cdFx0YXNzZXJ0LmVxdWFsKHNob3dDYWxsZWQsIGZhbHNlKTtcblx0fSk7XG5cblx0aXQoXCJ1c2VzIGNvbnRleHRfbGVuZ3RoIGZyb20gL2FwaS9zaG93IG1vZGVsX2luZm8gZm9yIHVua25vd24gbW9kZWxcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVscyA9IGF3YWl0IGRpc2NvdmVyTW9kZWxzKHtcblx0XHRcdGxpc3RNb2RlbHM6IGFzeW5jICgpID0+IHRhZ3NTdHViKFwiZ2VtaW5pLTMtZmxhc2gtcHJldmlldzpsYXRlc3RcIiksXG5cdFx0XHRzaG93TW9kZWw6IGFzeW5jICgpID0+IHNob3dTdHViKHsgXCJnZW1pbmkuY29udGV4dF9sZW5ndGhcIjogMTA0ODU3NiB9KSxcblx0XHR9KTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWxzWzBdLmNvbnRleHRXaW5kb3csIDEwNDg1NzYpO1xuXHR9KTtcblxuXHRpdChcImZhbGxzIGJhY2sgdG8gODE5MiB3aGVuIC9hcGkvc2hvdyBtb2RlbF9pbmZvIGhhcyBubyBjb250ZXh0X2xlbmd0aCBrZXlcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVscyA9IGF3YWl0IGRpc2NvdmVyTW9kZWxzKHtcblx0XHRcdGxpc3RNb2RlbHM6IGFzeW5jICgpID0+IHRhZ3NTdHViKFwidW5rbm93bi1tb2RlbDpsYXRlc3RcIiksXG5cdFx0XHRzaG93TW9kZWw6IGFzeW5jICgpID0+IHNob3dTdHViKHt9KSxcblx0XHR9KTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWxzWzBdLmNvbnRleHRXaW5kb3csIDgxOTIpO1xuXHR9KTtcblxuXHRpdChcImZhbGxzIGJhY2sgdG8gODE5MiB3aGVuIC9hcGkvc2hvdyB0aHJvd3NcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG1vZGVscyA9IGF3YWl0IGRpc2NvdmVyTW9kZWxzKHtcblx0XHRcdGxpc3RNb2RlbHM6IGFzeW5jICgpID0+IHRhZ3NTdHViKFwidW5rbm93bi1tb2RlbDpsYXRlc3RcIiksXG5cdFx0XHRzaG93TW9kZWw6IGFzeW5jICgpID0+IHsgdGhyb3cgbmV3IEVycm9yKFwibmV0d29yayBlcnJvclwiKTsgfSxcblx0XHR9KTtcblx0XHRhc3NlcnQuZXF1YWwobW9kZWxzWzBdLmNvbnRleHRXaW5kb3csIDgxOTIpO1xuXHR9KTtcbn0pOyJdLAogICJtYXBwaW5ncyI6ICJBQUNBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQixTQUFTLHNCQUFzQjtBQUcvQixNQUFNLGdCQUFnQixFQUFFLGNBQWMsSUFBSSxRQUFRLElBQUksUUFBUSxJQUFJLFVBQVUsTUFBTSxnQkFBZ0IsSUFBSSxvQkFBb0IsR0FBRztBQUU3SCxTQUFTLFVBQVUsTUFBYyxnQkFBZ0IsSUFBSTtBQUNwRCxTQUFPLEVBQUUsTUFBTSxPQUFPLE1BQU0sYUFBYSxJQUFJLE1BQU0sR0FBRyxRQUFRLElBQUksU0FBUyxFQUFFLEdBQUcsZUFBZSxnQkFBZ0IsY0FBYyxFQUFFO0FBQ2hJO0FBRUEsU0FBUyxTQUFTLE1BQWMsZ0JBQWdCLElBQXdCO0FBQ3ZFLFNBQU8sRUFBRSxRQUFRLENBQUMsVUFBVSxNQUFNLGFBQWEsQ0FBQyxFQUFFO0FBQ25EO0FBRUEsU0FBUyxTQUFTLFdBQXdEO0FBQ3pFLFNBQU8sRUFBRSxXQUFXLElBQUksWUFBWSxJQUFJLFVBQVUsSUFBSSxTQUFTLGVBQWUsWUFBWSxVQUFVO0FBQ3JHO0FBRUEsU0FBUyxtREFBOEMsTUFBTTtBQUM1RCxLQUFHLDZEQUE2RCxZQUFZO0FBQzNFLFFBQUksYUFBYTtBQUNqQixVQUFNLFNBQVMsTUFBTSxlQUFlO0FBQUEsTUFDbkMsWUFBWSxZQUFZLFNBQVMsbUJBQW1CLElBQUk7QUFBQSxNQUN4RCxXQUFXLFlBQVk7QUFBRSxxQkFBYTtBQUFNLGNBQU0sSUFBSSxNQUFNLHNCQUFzQjtBQUFBLE1BQUc7QUFBQSxJQUN0RixDQUFDO0FBQ0QsV0FBTyxNQUFNLE9BQU8sQ0FBQyxFQUFFLGVBQWUsTUFBTTtBQUM1QyxXQUFPLE1BQU0sWUFBWSxLQUFLO0FBQUEsRUFDL0IsQ0FBQztBQUVELEtBQUcsbUVBQW1FLFlBQVk7QUFDakYsVUFBTSxTQUFTLE1BQU0sZUFBZTtBQUFBLE1BQ25DLFlBQVksWUFBWSxTQUFTLCtCQUErQjtBQUFBLE1BQ2hFLFdBQVcsWUFBWSxTQUFTLEVBQUUseUJBQXlCLFFBQVEsQ0FBQztBQUFBLElBQ3JFLENBQUM7QUFDRCxXQUFPLE1BQU0sT0FBTyxDQUFDLEVBQUUsZUFBZSxPQUFPO0FBQUEsRUFDOUMsQ0FBQztBQUVELEtBQUcsMEVBQTBFLFlBQVk7QUFDeEYsVUFBTSxTQUFTLE1BQU0sZUFBZTtBQUFBLE1BQ25DLFlBQVksWUFBWSxTQUFTLHNCQUFzQjtBQUFBLE1BQ3ZELFdBQVcsWUFBWSxTQUFTLENBQUMsQ0FBQztBQUFBLElBQ25DLENBQUM7QUFDRCxXQUFPLE1BQU0sT0FBTyxDQUFDLEVBQUUsZUFBZSxJQUFJO0FBQUEsRUFDM0MsQ0FBQztBQUVELEtBQUcsNENBQTRDLFlBQVk7QUFDMUQsVUFBTSxTQUFTLE1BQU0sZUFBZTtBQUFBLE1BQ25DLFlBQVksWUFBWSxTQUFTLHNCQUFzQjtBQUFBLE1BQ3ZELFdBQVcsWUFBWTtBQUFFLGNBQU0sSUFBSSxNQUFNLGVBQWU7QUFBQSxNQUFHO0FBQUEsSUFDNUQsQ0FBQztBQUNELFdBQU8sTUFBTSxPQUFPLENBQUMsRUFBRSxlQUFlLElBQUk7QUFBQSxFQUMzQyxDQUFDO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
