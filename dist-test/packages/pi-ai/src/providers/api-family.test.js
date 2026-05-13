import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isAnthropicApi,
  isBedrockApi,
  isGeminiApi,
  isOpenAIApi
} from "./api-family.js";
const ALL_REGISTERED_APIS = [
  "anthropic-messages",
  "anthropic-vertex",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
  "bedrock-converse-stream",
  "mistral-conversations"
];
describe("isAnthropicApi", () => {
  test("matches anthropic-messages and anthropic-vertex", () => {
    assert.equal(isAnthropicApi({ api: "anthropic-messages" }), true);
    assert.equal(isAnthropicApi({ api: "anthropic-vertex" }), true);
  });
  test("excludes bedrock-converse-stream (different tool schema)", () => {
    assert.equal(isAnthropicApi({ api: "bedrock-converse-stream" }), false);
  });
  test("excludes every non-Anthropic registered api", () => {
    const nonAnthropic = ALL_REGISTERED_APIS.filter(
      (a) => a !== "anthropic-messages" && a !== "anthropic-vertex"
    );
    for (const api of nonAnthropic) {
      assert.equal(isAnthropicApi({ api }), false, `api=${api}`);
    }
  });
  test("tolerates null/undefined/missing api", () => {
    assert.equal(isAnthropicApi(null), false);
    assert.equal(isAnthropicApi(void 0), false);
    assert.equal(isAnthropicApi({}), false);
    assert.equal(isAnthropicApi({ api: "" }), false);
  });
});
describe("isOpenAIApi", () => {
  test("matches all OpenAI-shaped apis", () => {
    for (const api of [
      "openai-completions",
      "openai-responses",
      "azure-openai-responses",
      "openai-codex-responses"
    ]) {
      assert.equal(isOpenAIApi({ api }), true, `api=${api}`);
    }
  });
  test("excludes every non-OpenAI registered api", () => {
    const nonOpenAI = ALL_REGISTERED_APIS.filter(
      (a) => a !== "openai-completions" && a !== "openai-responses" && a !== "azure-openai-responses" && a !== "openai-codex-responses"
    );
    for (const api of nonOpenAI) {
      assert.equal(isOpenAIApi({ api }), false, `api=${api}`);
    }
  });
});
describe("isGeminiApi", () => {
  test("matches all Gemini-shaped apis", () => {
    for (const api of ["google-generative-ai", "google-gemini-cli", "google-vertex"]) {
      assert.equal(isGeminiApi({ api }), true, `api=${api}`);
    }
  });
  test("excludes every non-Gemini registered api", () => {
    const nonGemini = ALL_REGISTERED_APIS.filter(
      (a) => a !== "google-generative-ai" && a !== "google-gemini-cli" && a !== "google-vertex"
    );
    for (const api of nonGemini) {
      assert.equal(isGeminiApi({ api }), false, `api=${api}`);
    }
  });
});
describe("isBedrockApi", () => {
  test("matches only bedrock-converse-stream", () => {
    assert.equal(isBedrockApi({ api: "bedrock-converse-stream" }), true);
    for (const api of ALL_REGISTERED_APIS.filter((a) => a !== "bedrock-converse-stream")) {
      assert.equal(isBedrockApi({ api }), false, `api=${api}`);
    }
  });
});
describe("api-family exclusivity", () => {
  test("every registered api belongs to exactly one family (or mistral = none)", () => {
    for (const api of ALL_REGISTERED_APIS) {
      const matches = [
        isAnthropicApi({ api }),
        isOpenAIApi({ api }),
        isGeminiApi({ api }),
        isBedrockApi({ api })
      ].filter(Boolean).length;
      const expected = api === "mistral-conversations" ? 0 : 1;
      assert.equal(
        matches,
        expected,
        `api=${api} matched ${matches} families (expected ${expected})`
      );
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9hcGktZmFtaWx5LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIGdzZC0yIC8gcGktYWk6IGFwaS1mYW1pbHkgcHJlZGljYXRlIHRlc3RzXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQge1xuICBpc0FudGhyb3BpY0FwaSxcbiAgaXNCZWRyb2NrQXBpLFxuICBpc0dlbWluaUFwaSxcbiAgaXNPcGVuQUlBcGksXG59IGZyb20gXCIuL2FwaS1mYW1pbHkuanNcIjtcblxuLy8gRXZlcnkgYXBpIHZhbHVlIHJlZ2lzdGVyZWQgdmlhIHJlZ2lzdGVyQXBpUHJvdmlkZXIoKSBpbiByZWdpc3Rlci1idWlsdGlucy50cy5cbi8vIEtlZXAgaW4gc3luYyB3aXRoIHRoYXQgZmlsZSBcdTIwMTQgdGhlIGV4cGVjdGF0aW9ucyBiZWxvdyBhc3NlcnQgZXZlcnkgYXBpIGlzXG4vLyBjbGFzc2lmaWVkIGJ5IGV4YWN0bHkgb25lIGZhbWlseSAoZXhjZXB0IG1pc3RyYWwsIHdoaWNoIGlzIGl0cyBvd24gZmFtaWx5XG4vLyBhbmQgYmVsb25ncyB0byBub25lIG9mIHRoZSBoZWxwZXJzKS5cbmNvbnN0IEFMTF9SRUdJU1RFUkVEX0FQSVMgPSBbXG4gIFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG4gIFwiYW50aHJvcGljLXZlcnRleFwiLFxuICBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuICBcIm9wZW5haS1yZXNwb25zZXNcIixcbiAgXCJhenVyZS1vcGVuYWktcmVzcG9uc2VzXCIsXG4gIFwib3BlbmFpLWNvZGV4LXJlc3BvbnNlc1wiLFxuICBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIsXG4gIFwiZ29vZ2xlLWdlbWluaS1jbGlcIixcbiAgXCJnb29nbGUtdmVydGV4XCIsXG4gIFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcbiAgXCJtaXN0cmFsLWNvbnZlcnNhdGlvbnNcIixcbl0gYXMgY29uc3Q7XG5cbmRlc2NyaWJlKFwiaXNBbnRocm9waWNBcGlcIiwgKCkgPT4ge1xuICB0ZXN0KFwibWF0Y2hlcyBhbnRocm9waWMtbWVzc2FnZXMgYW5kIGFudGhyb3BpYy12ZXJ0ZXhcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChpc0FudGhyb3BpY0FwaSh7IGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9KSwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQW50aHJvcGljQXBpKHsgYXBpOiBcImFudGhyb3BpYy12ZXJ0ZXhcIiB9KSwgdHJ1ZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJleGNsdWRlcyBiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbSAoZGlmZmVyZW50IHRvb2wgc2NoZW1hKVwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQW50aHJvcGljQXBpKHsgYXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIgfSksIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcImV4Y2x1ZGVzIGV2ZXJ5IG5vbi1BbnRocm9waWMgcmVnaXN0ZXJlZCBhcGlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG5vbkFudGhyb3BpYyA9IEFMTF9SRUdJU1RFUkVEX0FQSVMuZmlsdGVyKFxuICAgICAgKGEpID0+IGEgIT09IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIgJiYgYSAhPT0gXCJhbnRocm9waWMtdmVydGV4XCIsXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IGFwaSBvZiBub25BbnRocm9waWMpIHtcbiAgICAgIGFzc2VydC5lcXVhbChpc0FudGhyb3BpY0FwaSh7IGFwaSB9KSwgZmFsc2UsIGBhcGk9JHthcGl9YCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwidG9sZXJhdGVzIG51bGwvdW5kZWZpbmVkL21pc3NpbmcgYXBpXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoaXNBbnRocm9waWNBcGkobnVsbCksIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNBbnRocm9waWNBcGkodW5kZWZpbmVkKSwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChpc0FudGhyb3BpY0FwaSh7fSksIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNBbnRocm9waWNBcGkoeyBhcGk6IFwiXCIgfSksIGZhbHNlKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJpc09wZW5BSUFwaVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJtYXRjaGVzIGFsbCBPcGVuQUktc2hhcGVkIGFwaXNcIiwgKCkgPT4ge1xuICAgIGZvciAoY29uc3QgYXBpIG9mIFtcbiAgICAgIFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG4gICAgICBcIm9wZW5haS1yZXNwb25zZXNcIixcbiAgICAgIFwiYXp1cmUtb3BlbmFpLXJlc3BvbnNlc1wiLFxuICAgICAgXCJvcGVuYWktY29kZXgtcmVzcG9uc2VzXCIsXG4gICAgXSkge1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzT3BlbkFJQXBpKHsgYXBpIH0pLCB0cnVlLCBgYXBpPSR7YXBpfWApO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImV4Y2x1ZGVzIGV2ZXJ5IG5vbi1PcGVuQUkgcmVnaXN0ZXJlZCBhcGlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG5vbk9wZW5BSSA9IEFMTF9SRUdJU1RFUkVEX0FQSVMuZmlsdGVyKFxuICAgICAgKGEpID0+XG4gICAgICAgIGEgIT09IFwib3BlbmFpLWNvbXBsZXRpb25zXCIgJiZcbiAgICAgICAgYSAhPT0gXCJvcGVuYWktcmVzcG9uc2VzXCIgJiZcbiAgICAgICAgYSAhPT0gXCJhenVyZS1vcGVuYWktcmVzcG9uc2VzXCIgJiZcbiAgICAgICAgYSAhPT0gXCJvcGVuYWktY29kZXgtcmVzcG9uc2VzXCIsXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IGFwaSBvZiBub25PcGVuQUkpIHtcbiAgICAgIGFzc2VydC5lcXVhbChpc09wZW5BSUFwaSh7IGFwaSB9KSwgZmFsc2UsIGBhcGk9JHthcGl9YCk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcImlzR2VtaW5pQXBpXCIsICgpID0+IHtcbiAgdGVzdChcIm1hdGNoZXMgYWxsIEdlbWluaS1zaGFwZWQgYXBpc1wiLCAoKSA9PiB7XG4gICAgZm9yIChjb25zdCBhcGkgb2YgW1wiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIiwgXCJnb29nbGUtZ2VtaW5pLWNsaVwiLCBcImdvb2dsZS12ZXJ0ZXhcIl0pIHtcbiAgICAgIGFzc2VydC5lcXVhbChpc0dlbWluaUFwaSh7IGFwaSB9KSwgdHJ1ZSwgYGFwaT0ke2FwaX1gKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJleGNsdWRlcyBldmVyeSBub24tR2VtaW5pIHJlZ2lzdGVyZWQgYXBpXCIsICgpID0+IHtcbiAgICBjb25zdCBub25HZW1pbmkgPSBBTExfUkVHSVNURVJFRF9BUElTLmZpbHRlcihcbiAgICAgIChhKSA9PlxuICAgICAgICBhICE9PSBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIgJiZcbiAgICAgICAgYSAhPT0gXCJnb29nbGUtZ2VtaW5pLWNsaVwiICYmXG4gICAgICAgIGEgIT09IFwiZ29vZ2xlLXZlcnRleFwiLFxuICAgICk7XG4gICAgZm9yIChjb25zdCBhcGkgb2Ygbm9uR2VtaW5pKSB7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNHZW1pbmlBcGkoeyBhcGkgfSksIGZhbHNlLCBgYXBpPSR7YXBpfWApO1xuICAgIH1cbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJpc0JlZHJvY2tBcGlcIiwgKCkgPT4ge1xuICB0ZXN0KFwibWF0Y2hlcyBvbmx5IGJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoaXNCZWRyb2NrQXBpKHsgYXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIgfSksIHRydWUpO1xuICAgIGZvciAoY29uc3QgYXBpIG9mIEFMTF9SRUdJU1RFUkVEX0FQSVMuZmlsdGVyKChhKSA9PiBhICE9PSBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIpKSB7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNCZWRyb2NrQXBpKHsgYXBpIH0pLCBmYWxzZSwgYGFwaT0ke2FwaX1gKTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiYXBpLWZhbWlseSBleGNsdXNpdml0eVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJldmVyeSByZWdpc3RlcmVkIGFwaSBiZWxvbmdzIHRvIGV4YWN0bHkgb25lIGZhbWlseSAob3IgbWlzdHJhbCA9IG5vbmUpXCIsICgpID0+IHtcbiAgICBmb3IgKGNvbnN0IGFwaSBvZiBBTExfUkVHSVNURVJFRF9BUElTKSB7XG4gICAgICBjb25zdCBtYXRjaGVzID0gW1xuICAgICAgICBpc0FudGhyb3BpY0FwaSh7IGFwaSB9KSxcbiAgICAgICAgaXNPcGVuQUlBcGkoeyBhcGkgfSksXG4gICAgICAgIGlzR2VtaW5pQXBpKHsgYXBpIH0pLFxuICAgICAgICBpc0JlZHJvY2tBcGkoeyBhcGkgfSksXG4gICAgICBdLmZpbHRlcihCb29sZWFuKS5sZW5ndGg7XG4gICAgICBjb25zdCBleHBlY3RlZCA9IGFwaSA9PT0gXCJtaXN0cmFsLWNvbnZlcnNhdGlvbnNcIiA/IDAgOiAxO1xuICAgICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgICBtYXRjaGVzLFxuICAgICAgICBleHBlY3RlZCxcbiAgICAgICAgYGFwaT0ke2FwaX0gbWF0Y2hlZCAke21hdGNoZXN9IGZhbWlsaWVzIChleHBlY3RlZCAke2V4cGVjdGVkfSlgLFxuICAgICAgKTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFFbkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQU1QLE1BQU0sc0JBQXNCO0FB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
