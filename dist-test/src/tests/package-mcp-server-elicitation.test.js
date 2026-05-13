import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  buildAskUserQuestionsElicitRequest,
  createMcpServer,
  formatAskUserQuestionsElicitResult
} from "../../packages/mcp-server/src/server.js";
function createSessionManagerStub() {
  return {
    startSession: async () => {
      throw new Error("not implemented in test");
    },
    getSession: () => void 0,
    getResult: () => void 0,
    cancelSession: async () => {
    },
    resolveBlocker: async () => {
    }
  };
}
async function createConnectedClient(options) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = await createMcpServer(createSessionManagerStub());
  const client = new Client({
    name: "test-client",
    version: "0.0.0"
  }, {
    capabilities: {
      elicitation: {}
    }
  });
  if (options?.onElicit) {
    client.setRequestHandler(ElicitRequestSchema, options.onElicit);
  }
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}
test("package MCP server exposes ask_user_questions over listTools", async () => {
  const { client, close } = await createConnectedClient();
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "ask_user_questions"));
  } finally {
    await close();
  }
});
test("ask_user_questions returns the packaged answers JSON shape for form elicitation", async () => {
  const { client, close } = await createConnectedClient({
    onElicit: async (request) => {
      const elicitation = request.params ?? request;
      assert.match(elicitation.message, /Please answer the following question/);
      assert.ok(elicitation.requestedSchema.properties.deployment);
      assert.ok(elicitation.requestedSchema.properties["deployment__note"]);
      assert.ok(elicitation.requestedSchema.required?.includes("deployment"));
      return {
        action: "accept",
        content: {
          deployment: "None of the above",
          deployment__note: "Need hybrid deployment."
        }
      };
    }
  });
  try {
    const result = await client.callTool({
      name: "ask_user_questions",
      arguments: {
        questions: [
          {
            id: "deployment",
            header: "Deploy",
            question: "Where will this run?",
            options: [
              { label: "Cloud", description: "Managed hosting." },
              { label: "On-prem", description: "Runs in customer infrastructure." }
            ]
          }
        ]
      }
    });
    const text = result.content.find((item) => item.type === "text");
    assert.ok(text && "text" in text);
    assert.equal(
      text.text,
      JSON.stringify({
        answers: {
          deployment: {
            answers: ["None of the above", "user_note: Need hybrid deployment."]
          }
        }
      })
    );
    assert.deepEqual(
      result.structuredContent,
      {
        questions: [
          {
            id: "deployment",
            header: "Deploy",
            question: "Where will this run?",
            options: [
              { label: "Cloud", description: "Managed hosting." },
              { label: "On-prem", description: "Runs in customer infrastructure." }
            ]
          }
        ],
        response: {
          endInterview: false,
          answers: {
            deployment: { selected: "None of the above", notes: "Need hybrid deployment." }
          }
        },
        cancelled: false
      }
    );
  } finally {
    await close();
  }
});
test("ask_user_questions structuredContent reflects an accepted single-select answer", async () => {
  const { client, close } = await createConnectedClient({
    onElicit: async () => ({
      action: "accept",
      content: { confirm: "Yes, you got it (Recommended)" }
    })
  });
  try {
    const result = await client.callTool({
      name: "ask_user_questions",
      arguments: {
        questions: [
          {
            id: "confirm",
            header: "Depth Check",
            question: "Did I capture the scope correctly?",
            options: [
              { label: "Yes, you got it (Recommended)", description: "Proceed." },
              { label: "Not quite \u2014 let me clarify", description: "Adjust." }
            ]
          }
        ]
      }
    });
    assert.deepEqual(
      result.structuredContent,
      {
        questions: [
          {
            id: "confirm",
            header: "Depth Check",
            question: "Did I capture the scope correctly?",
            options: [
              { label: "Yes, you got it (Recommended)", description: "Proceed." },
              { label: "Not quite \u2014 let me clarify", description: "Adjust." }
            ]
          }
        ],
        response: {
          endInterview: false,
          answers: {
            confirm: { selected: "Yes, you got it (Recommended)", notes: "" }
          }
        },
        cancelled: false
      }
    );
  } finally {
    await close();
  }
});
test("ask_user_questions structuredContent reflects an accepted multi-select answer", async () => {
  const { client, close } = await createConnectedClient({
    onElicit: async () => ({
      action: "accept",
      content: { focus: ["Frontend", "Backend"] }
    })
  });
  try {
    const result = await client.callTool({
      name: "ask_user_questions",
      arguments: {
        questions: [
          {
            id: "focus",
            header: "Focus",
            question: "Which areas matter most?",
            allowMultiple: true,
            options: [
              { label: "Frontend", description: "UI work." },
              { label: "Backend", description: "Server work." },
              { label: "Infra", description: "Ops work." }
            ]
          }
        ]
      }
    });
    const structured = result.structuredContent;
    assert.deepEqual(structured?.response?.answers?.focus, { selected: ["Frontend", "Backend"], notes: "" });
    assert.equal(result.structuredContent?.cancelled, false);
  } finally {
    await close();
  }
});
test("ask_user_questions returns an error result for invalid question payloads", async () => {
  const { client, close } = await createConnectedClient();
  try {
    const result = await client.callTool({
      name: "ask_user_questions",
      arguments: {
        questions: [
          {
            id: "broken",
            header: "Broken",
            question: "This payload is invalid",
            options: []
          }
        ]
      }
    });
    const text = result.content.find((item) => item.type === "text");
    assert.ok(text && "text" in text);
    assert.equal(result.isError, true);
    assert.match(text.text, /requires non-empty options/i);
  } finally {
    await close();
  }
});
test("ask_user_questions returns the cancellation message when elicitation is declined", async () => {
  const { client, close } = await createConnectedClient({
    onElicit: async () => ({
      action: "decline"
    })
  });
  try {
    const result = await client.callTool({
      name: "ask_user_questions",
      arguments: {
        questions: [
          {
            id: "continue",
            header: "Continue",
            question: "Continue?",
            options: [
              { label: "Yes", description: "Proceed." },
              { label: "No", description: "Stop here." }
            ]
          }
        ]
      }
    });
    const text = result.content.find((item) => item.type === "text");
    assert.ok(text && "text" in text);
    assert.equal(text.text, "ask_user_questions was cancelled before receiving a response");
    assert.deepEqual(
      result.structuredContent,
      {
        questions: [
          {
            id: "continue",
            header: "Continue",
            question: "Continue?",
            options: [
              { label: "Yes", description: "Proceed." },
              { label: "No", description: "Stop here." }
            ]
          }
        ],
        response: null,
        cancelled: true
      }
    );
  } finally {
    await close();
  }
});
test("buildAskUserQuestionsRoundResult normalizes elicitation content into the gate-hook shape", async () => {
  const mod = await import("../../packages/mcp-server/src/server.js");
  const buildAskUserQuestionsRoundResult = mod.buildAskUserQuestionsRoundResult;
  assert.equal(typeof buildAskUserQuestionsRoundResult, "function", "Helper buildAskUserQuestionsRoundResult must be exported from packages/mcp-server (regression #5267)");
  const questions = [
    { id: "confirm", header: "Confirm", question: "Proceed?", options: [
      { label: "Yes", description: "Go." },
      { label: "No", description: "Stop." }
    ] },
    { id: "focus", header: "Focus", question: "Which area?", allowMultiple: true, options: [
      { label: "Frontend", description: "UI work." },
      { label: "Backend", description: "Server work." }
    ] }
  ];
  const accepted = buildAskUserQuestionsRoundResult(questions, {
    action: "accept",
    content: {
      confirm: "Yes",
      focus: ["Frontend", "Backend"]
    }
  });
  assert.deepEqual(accepted, {
    endInterview: false,
    answers: {
      confirm: { selected: "Yes", notes: "" },
      focus: { selected: ["Frontend", "Backend"], notes: "" }
    }
  });
  const noteCarrying = buildAskUserQuestionsRoundResult([questions[0]], {
    action: "accept",
    content: {
      confirm: "None of the above",
      confirm__note: "Want a hybrid path."
    }
  });
  assert.deepEqual(noteCarrying.answers.confirm, { selected: "None of the above", notes: "Want a hybrid path." });
});
test("helper formatting stays aligned with the tool contract", () => {
  const questions = [
    {
      id: "focus_areas",
      header: "Focus",
      question: "Which areas matter most?",
      allowMultiple: true,
      options: [
        { label: "Frontend", description: "Prioritize the UI." },
        { label: "Backend", description: "Prioritize server logic." }
      ]
    }
  ];
  const request = buildAskUserQuestionsElicitRequest(questions);
  assert.equal(request.mode, "form");
  assert.ok(request.requestedSchema.properties.focus_areas);
  assert.ok(!request.requestedSchema.properties["focus_areas__note"]);
  const formatted = formatAskUserQuestionsElicitResult(questions, {
    action: "accept",
    content: {
      focus_areas: ["Frontend", "Backend"]
    }
  });
  assert.equal(
    formatted,
    JSON.stringify({
      answers: {
        focus_areas: {
          answers: ["Frontend", "Backend"]
        }
      }
    })
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL3BhY2thZ2UtbWNwLXNlcnZlci1lbGljaXRhdGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnXG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCdcbmltcG9ydCB7IENsaWVudCB9IGZyb20gJ0Btb2RlbGNvbnRleHRwcm90b2NvbC9zZGsvY2xpZW50L2luZGV4LmpzJ1xuaW1wb3J0IHsgSW5NZW1vcnlUcmFuc3BvcnQgfSBmcm9tICdAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL2luTWVtb3J5LmpzJ1xuaW1wb3J0IHsgRWxpY2l0UmVxdWVzdFNjaGVtYSB9IGZyb20gJ0Btb2RlbGNvbnRleHRwcm90b2NvbC9zZGsvdHlwZXMuanMnXG5cbmltcG9ydCB7XG4gIGJ1aWxkQXNrVXNlclF1ZXN0aW9uc0VsaWNpdFJlcXVlc3QsXG4gIGNyZWF0ZU1jcFNlcnZlcixcbiAgZm9ybWF0QXNrVXNlclF1ZXN0aW9uc0VsaWNpdFJlc3VsdCxcbn0gZnJvbSAnLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvc2VydmVyLmpzJ1xuXG5mdW5jdGlvbiBjcmVhdGVTZXNzaW9uTWFuYWdlclN0dWIoKSB7XG4gIHJldHVybiB7XG4gICAgc3RhcnRTZXNzaW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ25vdCBpbXBsZW1lbnRlZCBpbiB0ZXN0JylcbiAgICB9LFxuICAgIGdldFNlc3Npb246ICgpID0+IHVuZGVmaW5lZCxcbiAgICBnZXRSZXN1bHQ6ICgpID0+IHVuZGVmaW5lZCxcbiAgICBjYW5jZWxTZXNzaW9uOiBhc3luYyAoKSA9PiB7fSxcbiAgICByZXNvbHZlQmxvY2tlcjogYXN5bmMgKCkgPT4ge30sXG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY3JlYXRlQ29ubmVjdGVkQ2xpZW50KG9wdGlvbnM/OiB7XG4gIG9uRWxpY2l0PzogKHBhcmFtczogdW5rbm93bikgPT4gUHJvbWlzZTx1bmtub3duPixcbn0pIHtcbiAgY29uc3QgW2NsaWVudFRyYW5zcG9ydCwgc2VydmVyVHJhbnNwb3J0XSA9IEluTWVtb3J5VHJhbnNwb3J0LmNyZWF0ZUxpbmtlZFBhaXIoKVxuXG4gIGNvbnN0IHsgc2VydmVyIH0gPSBhd2FpdCBjcmVhdGVNY3BTZXJ2ZXIoY3JlYXRlU2Vzc2lvbk1hbmFnZXJTdHViKCkgYXMgbmV2ZXIpXG4gIGNvbnN0IGNsaWVudCA9IG5ldyBDbGllbnQoe1xuICAgIG5hbWU6ICd0ZXN0LWNsaWVudCcsXG4gICAgdmVyc2lvbjogJzAuMC4wJyxcbiAgfSwge1xuICAgIGNhcGFiaWxpdGllczoge1xuICAgICAgZWxpY2l0YXRpb246IHt9LFxuICAgIH0sXG4gIH0pXG5cbiAgaWYgKG9wdGlvbnM/Lm9uRWxpY2l0KSB7XG4gICAgY2xpZW50LnNldFJlcXVlc3RIYW5kbGVyKEVsaWNpdFJlcXVlc3RTY2hlbWEsIG9wdGlvbnMub25FbGljaXQpXG4gIH1cblxuICBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgc2VydmVyLmNvbm5lY3Qoc2VydmVyVHJhbnNwb3J0KSxcbiAgICBjbGllbnQuY29ubmVjdChjbGllbnRUcmFuc3BvcnQpLFxuICBdKVxuXG4gIHJldHVybiB7XG4gICAgY2xpZW50LFxuICAgIGNsb3NlOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbGllbnQuY2xvc2UoKVxuICAgICAgYXdhaXQgc2VydmVyLmNsb3NlKClcbiAgICB9LFxuICB9XG59XG5cbnRlc3QoJ3BhY2thZ2UgTUNQIHNlcnZlciBleHBvc2VzIGFza191c2VyX3F1ZXN0aW9ucyBvdmVyIGxpc3RUb29scycsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBjbGllbnQsIGNsb3NlIH0gPSBhd2FpdCBjcmVhdGVDb25uZWN0ZWRDbGllbnQoKVxuXG4gIHRyeSB7XG4gICAgY29uc3QgdG9vbHMgPSBhd2FpdCBjbGllbnQubGlzdFRvb2xzKClcbiAgICBhc3NlcnQub2sodG9vbHMudG9vbHMuc29tZSh0b29sID0+IHRvb2wubmFtZSA9PT0gJ2Fza191c2VyX3F1ZXN0aW9ucycpKVxuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IGNsb3NlKClcbiAgfVxufSlcblxudGVzdCgnYXNrX3VzZXJfcXVlc3Rpb25zIHJldHVybnMgdGhlIHBhY2thZ2VkIGFuc3dlcnMgSlNPTiBzaGFwZSBmb3IgZm9ybSBlbGljaXRhdGlvbicsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBjbGllbnQsIGNsb3NlIH0gPSBhd2FpdCBjcmVhdGVDb25uZWN0ZWRDbGllbnQoe1xuICAgIG9uRWxpY2l0OiBhc3luYyAocmVxdWVzdCkgPT4ge1xuICAgICAgY29uc3QgZWxpY2l0YXRpb24gPSAocmVxdWVzdCBhcyB7XG4gICAgICAgIHBhcmFtcz86IHtcbiAgICAgICAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgICAgICAgcmVxdWVzdGVkU2NoZW1hOiB7IHByb3BlcnRpZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCByZXF1aXJlZD86IHN0cmluZ1tdIH0sXG4gICAgICAgIH0sXG4gICAgICB9KS5wYXJhbXMgPz8gcmVxdWVzdCBhcyB7XG4gICAgICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICAgICAgcmVxdWVzdGVkU2NoZW1hOiB7IHByb3BlcnRpZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCByZXF1aXJlZD86IHN0cmluZ1tdIH0sXG4gICAgICB9XG4gICAgICBhc3NlcnQubWF0Y2goZWxpY2l0YXRpb24ubWVzc2FnZSwgL1BsZWFzZSBhbnN3ZXIgdGhlIGZvbGxvd2luZyBxdWVzdGlvbi8pXG4gICAgICBhc3NlcnQub2soZWxpY2l0YXRpb24ucmVxdWVzdGVkU2NoZW1hLnByb3BlcnRpZXMuZGVwbG95bWVudClcbiAgICAgIGFzc2VydC5vayhlbGljaXRhdGlvbi5yZXF1ZXN0ZWRTY2hlbWEucHJvcGVydGllc1snZGVwbG95bWVudF9fbm90ZSddKVxuICAgICAgYXNzZXJ0Lm9rKGVsaWNpdGF0aW9uLnJlcXVlc3RlZFNjaGVtYS5yZXF1aXJlZD8uaW5jbHVkZXMoJ2RlcGxveW1lbnQnKSlcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiAnYWNjZXB0JyxcbiAgICAgICAgY29udGVudDoge1xuICAgICAgICAgIGRlcGxveW1lbnQ6ICdOb25lIG9mIHRoZSBhYm92ZScsXG4gICAgICAgICAgZGVwbG95bWVudF9fbm90ZTogJ05lZWQgaHlicmlkIGRlcGxveW1lbnQuJyxcbiAgICAgICAgfSxcbiAgICAgIH1cbiAgICB9LFxuICB9KVxuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xpZW50LmNhbGxUb29sKHtcbiAgICAgIG5hbWU6ICdhc2tfdXNlcl9xdWVzdGlvbnMnLFxuICAgICAgYXJndW1lbnRzOiB7XG4gICAgICAgIHF1ZXN0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIGlkOiAnZGVwbG95bWVudCcsXG4gICAgICAgICAgICBoZWFkZXI6ICdEZXBsb3knLFxuICAgICAgICAgICAgcXVlc3Rpb246ICdXaGVyZSB3aWxsIHRoaXMgcnVuPycsXG4gICAgICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgICAgIHsgbGFiZWw6ICdDbG91ZCcsIGRlc2NyaXB0aW9uOiAnTWFuYWdlZCBob3N0aW5nLicgfSxcbiAgICAgICAgICAgICAgeyBsYWJlbDogJ09uLXByZW0nLCBkZXNjcmlwdGlvbjogJ1J1bnMgaW4gY3VzdG9tZXIgaW5mcmFzdHJ1Y3R1cmUuJyB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9KVxuXG4gICAgY29uc3QgdGV4dCA9IHJlc3VsdC5jb250ZW50LmZpbmQoaXRlbSA9PiBpdGVtLnR5cGUgPT09ICd0ZXh0JylcbiAgICBhc3NlcnQub2sodGV4dCAmJiAndGV4dCcgaW4gdGV4dClcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICB0ZXh0LnRleHQsXG4gICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGFuc3dlcnM6IHtcbiAgICAgICAgICBkZXBsb3ltZW50OiB7XG4gICAgICAgICAgICBhbnN3ZXJzOiBbJ05vbmUgb2YgdGhlIGFib3ZlJywgJ3VzZXJfbm90ZTogTmVlZCBoeWJyaWQgZGVwbG95bWVudC4nXSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgKVxuXG4gICAgLy8gUmVncmVzc2lvbiAjNTI2NzogdGhlIGdhdGUgaG9vayByZWFkcyBgZGV0YWlscy5yZXNwb25zZS5hbnN3ZXJzW2lkXS5zZWxlY3RlZGBcbiAgICAvLyBvZmYgdGhlIE1DUCBgdG9vbF9yZXN1bHRgIGV2ZW50LiBUaGUgYnJpZGdlIG1hcHMgYHN0cnVjdHVyZWRDb250ZW50YFxuICAgIC8vIGludG8gYGRldGFpbHNgLCBzbyBhIG1pc3NpbmcgYHN0cnVjdHVyZWRDb250ZW50YCAob3Igd3JvbmcgaW5uZXIgc2hhcGUpXG4gICAgLy8gbWFrZXMgdGhlIGRpc2N1c3Npb24gZ2F0ZSBzdGF5IHBlbmRpbmcgZm9yZXZlciBhbmQgSEFSRC1CTE9DS3MgZXZlcnlcbiAgICAvLyBmb2xsb3ctdXAgdG9vbCBjYWxsLlxuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICAocmVzdWx0IGFzIHsgc3RydWN0dXJlZENvbnRlbnQ/OiB1bmtub3duIH0pLnN0cnVjdHVyZWRDb250ZW50LFxuICAgICAge1xuICAgICAgICBxdWVzdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBpZDogJ2RlcGxveW1lbnQnLFxuICAgICAgICAgICAgaGVhZGVyOiAnRGVwbG95JyxcbiAgICAgICAgICAgIHF1ZXN0aW9uOiAnV2hlcmUgd2lsbCB0aGlzIHJ1bj8nLFxuICAgICAgICAgICAgb3B0aW9uczogW1xuICAgICAgICAgICAgICB7IGxhYmVsOiAnQ2xvdWQnLCBkZXNjcmlwdGlvbjogJ01hbmFnZWQgaG9zdGluZy4nIH0sXG4gICAgICAgICAgICAgIHsgbGFiZWw6ICdPbi1wcmVtJywgZGVzY3JpcHRpb246ICdSdW5zIGluIGN1c3RvbWVyIGluZnJhc3RydWN0dXJlLicgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgICAgcmVzcG9uc2U6IHtcbiAgICAgICAgICBlbmRJbnRlcnZpZXc6IGZhbHNlLFxuICAgICAgICAgIGFuc3dlcnM6IHtcbiAgICAgICAgICAgIGRlcGxveW1lbnQ6IHsgc2VsZWN0ZWQ6ICdOb25lIG9mIHRoZSBhYm92ZScsIG5vdGVzOiAnTmVlZCBoeWJyaWQgZGVwbG95bWVudC4nIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgY2FuY2VsbGVkOiBmYWxzZSxcbiAgICAgIH0sXG4gICAgKVxuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IGNsb3NlKClcbiAgfVxufSlcblxudGVzdCgnYXNrX3VzZXJfcXVlc3Rpb25zIHN0cnVjdHVyZWRDb250ZW50IHJlZmxlY3RzIGFuIGFjY2VwdGVkIHNpbmdsZS1zZWxlY3QgYW5zd2VyJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGNsaWVudCwgY2xvc2UgfSA9IGF3YWl0IGNyZWF0ZUNvbm5lY3RlZENsaWVudCh7XG4gICAgb25FbGljaXQ6IGFzeW5jICgpID0+ICh7XG4gICAgICBhY3Rpb246ICdhY2NlcHQnLFxuICAgICAgY29udGVudDogeyBjb25maXJtOiAnWWVzLCB5b3UgZ290IGl0IChSZWNvbW1lbmRlZCknIH0sXG4gICAgfSksXG4gIH0pXG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbGllbnQuY2FsbFRvb2woe1xuICAgICAgbmFtZTogJ2Fza191c2VyX3F1ZXN0aW9ucycsXG4gICAgICBhcmd1bWVudHM6IHtcbiAgICAgICAgcXVlc3Rpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgaWQ6ICdjb25maXJtJyxcbiAgICAgICAgICAgIGhlYWRlcjogJ0RlcHRoIENoZWNrJyxcbiAgICAgICAgICAgIHF1ZXN0aW9uOiAnRGlkIEkgY2FwdHVyZSB0aGUgc2NvcGUgY29ycmVjdGx5PycsXG4gICAgICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgICAgIHsgbGFiZWw6ICdZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKScsIGRlc2NyaXB0aW9uOiAnUHJvY2VlZC4nIH0sXG4gICAgICAgICAgICAgIHsgbGFiZWw6ICdOb3QgcXVpdGUgXHUyMDE0IGxldCBtZSBjbGFyaWZ5JywgZGVzY3JpcHRpb246ICdBZGp1c3QuJyB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9KVxuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIChyZXN1bHQgYXMgeyBzdHJ1Y3R1cmVkQ29udGVudD86IHVua25vd24gfSkuc3RydWN0dXJlZENvbnRlbnQsXG4gICAgICB7XG4gICAgICAgIHF1ZXN0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIGlkOiAnY29uZmlybScsXG4gICAgICAgICAgICBoZWFkZXI6ICdEZXB0aCBDaGVjaycsXG4gICAgICAgICAgICBxdWVzdGlvbjogJ0RpZCBJIGNhcHR1cmUgdGhlIHNjb3BlIGNvcnJlY3RseT8nLFxuICAgICAgICAgICAgb3B0aW9uczogW1xuICAgICAgICAgICAgICB7IGxhYmVsOiAnWWVzLCB5b3UgZ290IGl0IChSZWNvbW1lbmRlZCknLCBkZXNjcmlwdGlvbjogJ1Byb2NlZWQuJyB9LFxuICAgICAgICAgICAgICB7IGxhYmVsOiAnTm90IHF1aXRlIFx1MjAxNCBsZXQgbWUgY2xhcmlmeScsIGRlc2NyaXB0aW9uOiAnQWRqdXN0LicgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgICAgcmVzcG9uc2U6IHtcbiAgICAgICAgICBlbmRJbnRlcnZpZXc6IGZhbHNlLFxuICAgICAgICAgIGFuc3dlcnM6IHtcbiAgICAgICAgICAgIGNvbmZpcm06IHsgc2VsZWN0ZWQ6ICdZZXMsIHlvdSBnb3QgaXQgKFJlY29tbWVuZGVkKScsIG5vdGVzOiAnJyB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGNhbmNlbGxlZDogZmFsc2UsXG4gICAgICB9LFxuICAgIClcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBjbG9zZSgpXG4gIH1cbn0pXG5cbnRlc3QoJ2Fza191c2VyX3F1ZXN0aW9ucyBzdHJ1Y3R1cmVkQ29udGVudCByZWZsZWN0cyBhbiBhY2NlcHRlZCBtdWx0aS1zZWxlY3QgYW5zd2VyJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGNsaWVudCwgY2xvc2UgfSA9IGF3YWl0IGNyZWF0ZUNvbm5lY3RlZENsaWVudCh7XG4gICAgb25FbGljaXQ6IGFzeW5jICgpID0+ICh7XG4gICAgICBhY3Rpb246ICdhY2NlcHQnLFxuICAgICAgY29udGVudDogeyBmb2N1czogWydGcm9udGVuZCcsICdCYWNrZW5kJ10gfSxcbiAgICB9KSxcbiAgfSlcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsaWVudC5jYWxsVG9vbCh7XG4gICAgICBuYW1lOiAnYXNrX3VzZXJfcXVlc3Rpb25zJyxcbiAgICAgIGFyZ3VtZW50czoge1xuICAgICAgICBxdWVzdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBpZDogJ2ZvY3VzJyxcbiAgICAgICAgICAgIGhlYWRlcjogJ0ZvY3VzJyxcbiAgICAgICAgICAgIHF1ZXN0aW9uOiAnV2hpY2ggYXJlYXMgbWF0dGVyIG1vc3Q/JyxcbiAgICAgICAgICAgIGFsbG93TXVsdGlwbGU6IHRydWUsXG4gICAgICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgICAgIHsgbGFiZWw6ICdGcm9udGVuZCcsIGRlc2NyaXB0aW9uOiAnVUkgd29yay4nIH0sXG4gICAgICAgICAgICAgIHsgbGFiZWw6ICdCYWNrZW5kJywgZGVzY3JpcHRpb246ICdTZXJ2ZXIgd29yay4nIH0sXG4gICAgICAgICAgICAgIHsgbGFiZWw6ICdJbmZyYScsIGRlc2NyaXB0aW9uOiAnT3BzIHdvcmsuJyB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9KVxuXG4gICAgY29uc3Qgc3RydWN0dXJlZCA9IChyZXN1bHQgYXMgeyBzdHJ1Y3R1cmVkQ29udGVudD86IHsgcmVzcG9uc2U/OiB7IGFuc3dlcnM/OiBSZWNvcmQ8c3RyaW5nLCB7IHNlbGVjdGVkOiB1bmtub3duOyBub3RlczogdW5rbm93biB9PiB9IH0gfSkuc3RydWN0dXJlZENvbnRlbnRcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHN0cnVjdHVyZWQ/LnJlc3BvbnNlPy5hbnN3ZXJzPy5mb2N1cywgeyBzZWxlY3RlZDogWydGcm9udGVuZCcsICdCYWNrZW5kJ10sIG5vdGVzOiAnJyB9KVxuICAgIGFzc2VydC5lcXVhbCgocmVzdWx0IGFzIHsgc3RydWN0dXJlZENvbnRlbnQ/OiB7IGNhbmNlbGxlZD86IHVua25vd24gfSB9KS5zdHJ1Y3R1cmVkQ29udGVudD8uY2FuY2VsbGVkLCBmYWxzZSlcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBjbG9zZSgpXG4gIH1cbn0pXG5cbnRlc3QoJ2Fza191c2VyX3F1ZXN0aW9ucyByZXR1cm5zIGFuIGVycm9yIHJlc3VsdCBmb3IgaW52YWxpZCBxdWVzdGlvbiBwYXlsb2FkcycsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBjbGllbnQsIGNsb3NlIH0gPSBhd2FpdCBjcmVhdGVDb25uZWN0ZWRDbGllbnQoKVxuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xpZW50LmNhbGxUb29sKHtcbiAgICAgIG5hbWU6ICdhc2tfdXNlcl9xdWVzdGlvbnMnLFxuICAgICAgYXJndW1lbnRzOiB7XG4gICAgICAgIHF1ZXN0aW9uczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIGlkOiAnYnJva2VuJyxcbiAgICAgICAgICAgIGhlYWRlcjogJ0Jyb2tlbicsXG4gICAgICAgICAgICBxdWVzdGlvbjogJ1RoaXMgcGF5bG9hZCBpcyBpbnZhbGlkJyxcbiAgICAgICAgICAgIG9wdGlvbnM6IFtdLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIH0pXG5cbiAgICBjb25zdCB0ZXh0ID0gcmVzdWx0LmNvbnRlbnQuZmluZChpdGVtID0+IGl0ZW0udHlwZSA9PT0gJ3RleHQnKVxuICAgIGFzc2VydC5vayh0ZXh0ICYmICd0ZXh0JyBpbiB0ZXh0KVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuaXNFcnJvciwgdHJ1ZSlcbiAgICBhc3NlcnQubWF0Y2godGV4dC50ZXh0LCAvcmVxdWlyZXMgbm9uLWVtcHR5IG9wdGlvbnMvaSlcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBjbG9zZSgpXG4gIH1cbn0pXG5cbnRlc3QoJ2Fza191c2VyX3F1ZXN0aW9ucyByZXR1cm5zIHRoZSBjYW5jZWxsYXRpb24gbWVzc2FnZSB3aGVuIGVsaWNpdGF0aW9uIGlzIGRlY2xpbmVkJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGNsaWVudCwgY2xvc2UgfSA9IGF3YWl0IGNyZWF0ZUNvbm5lY3RlZENsaWVudCh7XG4gICAgb25FbGljaXQ6IGFzeW5jICgpID0+ICh7XG4gICAgICBhY3Rpb246ICdkZWNsaW5lJyxcbiAgICB9KSxcbiAgfSlcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsaWVudC5jYWxsVG9vbCh7XG4gICAgICBuYW1lOiAnYXNrX3VzZXJfcXVlc3Rpb25zJyxcbiAgICAgIGFyZ3VtZW50czoge1xuICAgICAgICBxdWVzdGlvbnM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBpZDogJ2NvbnRpbnVlJyxcbiAgICAgICAgICAgIGhlYWRlcjogJ0NvbnRpbnVlJyxcbiAgICAgICAgICAgIHF1ZXN0aW9uOiAnQ29udGludWU/JyxcbiAgICAgICAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgICAgICAgeyBsYWJlbDogJ1llcycsIGRlc2NyaXB0aW9uOiAnUHJvY2VlZC4nIH0sXG4gICAgICAgICAgICAgIHsgbGFiZWw6ICdObycsIGRlc2NyaXB0aW9uOiAnU3RvcCBoZXJlLicgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgfSlcblxuICAgIGNvbnN0IHRleHQgPSByZXN1bHQuY29udGVudC5maW5kKGl0ZW0gPT4gaXRlbS50eXBlID09PSAndGV4dCcpXG4gICAgYXNzZXJ0Lm9rKHRleHQgJiYgJ3RleHQnIGluIHRleHQpXG4gICAgYXNzZXJ0LmVxdWFsKHRleHQudGV4dCwgJ2Fza191c2VyX3F1ZXN0aW9ucyB3YXMgY2FuY2VsbGVkIGJlZm9yZSByZWNlaXZpbmcgYSByZXNwb25zZScpXG5cbiAgICAvLyBSZWdyZXNzaW9uICM1MjY3OiB0aGUgY2FuY2VsL2RlY2xpbmUgcGF0aCBtdXN0IGFsc28gc3VyZmFjZSBhXG4gICAgLy8gc3RydWN0dXJlZENvbnRlbnQgcGF5bG9hZCBzbyB0aGUgZ2F0ZSBob29rIHJvdXRlcyB0aGUgY2FuY2VsIGJyYW5jaFxuICAgIC8vIChyZXNwb25zZTogbnVsbCwgY2FuY2VsbGVkOiB0cnVlKSBpbnN0ZWFkIG9mIGZhbGxpbmcgaW50byB0aGVcbiAgICAvLyBcIm1pc3NpbmcgZGV0YWlscyBcdTIxOTIgSEFSRCBCTE9DSyB3aXRoIG5vIHJlY292ZXJ5XCIgcGF0aC5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgICAgKHJlc3VsdCBhcyB7IHN0cnVjdHVyZWRDb250ZW50PzogdW5rbm93biB9KS5zdHJ1Y3R1cmVkQ29udGVudCxcbiAgICAgIHtcbiAgICAgICAgcXVlc3Rpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgaWQ6ICdjb250aW51ZScsXG4gICAgICAgICAgICBoZWFkZXI6ICdDb250aW51ZScsXG4gICAgICAgICAgICBxdWVzdGlvbjogJ0NvbnRpbnVlPycsXG4gICAgICAgICAgICBvcHRpb25zOiBbXG4gICAgICAgICAgICAgIHsgbGFiZWw6ICdZZXMnLCBkZXNjcmlwdGlvbjogJ1Byb2NlZWQuJyB9LFxuICAgICAgICAgICAgICB7IGxhYmVsOiAnTm8nLCBkZXNjcmlwdGlvbjogJ1N0b3AgaGVyZS4nIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICAgIHJlc3BvbnNlOiBudWxsLFxuICAgICAgICBjYW5jZWxsZWQ6IHRydWUsXG4gICAgICB9LFxuICAgIClcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBjbG9zZSgpXG4gIH1cbn0pXG5cbnRlc3QoJ2J1aWxkQXNrVXNlclF1ZXN0aW9uc1JvdW5kUmVzdWx0IG5vcm1hbGl6ZXMgZWxpY2l0YXRpb24gY29udGVudCBpbnRvIHRoZSBnYXRlLWhvb2sgc2hhcGUnLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IG1vZCA9IGF3YWl0IGltcG9ydCgnLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvc2VydmVyLmpzJykgYXMge1xuICAgIGJ1aWxkQXNrVXNlclF1ZXN0aW9uc1JvdW5kUmVzdWx0OiAocXVlc3Rpb25zOiB1bmtub3duW10sIHJlc3VsdDogeyBhY3Rpb246IHN0cmluZzsgY29udGVudD86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH0pID0+IHsgYW5zd2VyczogUmVjb3JkPHN0cmluZywgeyBzZWxlY3RlZDogc3RyaW5nIHwgc3RyaW5nW107IG5vdGVzOiBzdHJpbmcgfT4gfSxcbiAgfVxuICBjb25zdCBidWlsZEFza1VzZXJRdWVzdGlvbnNSb3VuZFJlc3VsdCA9IG1vZC5idWlsZEFza1VzZXJRdWVzdGlvbnNSb3VuZFJlc3VsdFxuICBhc3NlcnQuZXF1YWwodHlwZW9mIGJ1aWxkQXNrVXNlclF1ZXN0aW9uc1JvdW5kUmVzdWx0LCAnZnVuY3Rpb24nLCAnSGVscGVyIGJ1aWxkQXNrVXNlclF1ZXN0aW9uc1JvdW5kUmVzdWx0IG11c3QgYmUgZXhwb3J0ZWQgZnJvbSBwYWNrYWdlcy9tY3Atc2VydmVyIChyZWdyZXNzaW9uICM1MjY3KScpXG5cbiAgY29uc3QgcXVlc3Rpb25zID0gW1xuICAgIHsgaWQ6ICdjb25maXJtJywgaGVhZGVyOiAnQ29uZmlybScsIHF1ZXN0aW9uOiAnUHJvY2VlZD8nLCBvcHRpb25zOiBbXG4gICAgICB7IGxhYmVsOiAnWWVzJywgZGVzY3JpcHRpb246ICdHby4nIH0sXG4gICAgICB7IGxhYmVsOiAnTm8nLCBkZXNjcmlwdGlvbjogJ1N0b3AuJyB9LFxuICAgIF0gfSxcbiAgICB7IGlkOiAnZm9jdXMnLCBoZWFkZXI6ICdGb2N1cycsIHF1ZXN0aW9uOiAnV2hpY2ggYXJlYT8nLCBhbGxvd011bHRpcGxlOiB0cnVlLCBvcHRpb25zOiBbXG4gICAgICB7IGxhYmVsOiAnRnJvbnRlbmQnLCBkZXNjcmlwdGlvbjogJ1VJIHdvcmsuJyB9LFxuICAgICAgeyBsYWJlbDogJ0JhY2tlbmQnLCBkZXNjcmlwdGlvbjogJ1NlcnZlciB3b3JrLicgfSxcbiAgICBdIH0sXG4gIF1cblxuICBjb25zdCBhY2NlcHRlZCA9IGJ1aWxkQXNrVXNlclF1ZXN0aW9uc1JvdW5kUmVzdWx0KHF1ZXN0aW9ucywge1xuICAgIGFjdGlvbjogJ2FjY2VwdCcsXG4gICAgY29udGVudDoge1xuICAgICAgY29uZmlybTogJ1llcycsXG4gICAgICBmb2N1czogWydGcm9udGVuZCcsICdCYWNrZW5kJ10sXG4gICAgfSxcbiAgfSlcbiAgYXNzZXJ0LmRlZXBFcXVhbChhY2NlcHRlZCwge1xuICAgIGVuZEludGVydmlldzogZmFsc2UsXG4gICAgYW5zd2Vyczoge1xuICAgICAgY29uZmlybTogeyBzZWxlY3RlZDogJ1llcycsIG5vdGVzOiAnJyB9LFxuICAgICAgZm9jdXM6IHsgc2VsZWN0ZWQ6IFsnRnJvbnRlbmQnLCAnQmFja2VuZCddLCBub3RlczogJycgfSxcbiAgICB9LFxuICB9KVxuXG4gIGNvbnN0IG5vdGVDYXJyeWluZyA9IGJ1aWxkQXNrVXNlclF1ZXN0aW9uc1JvdW5kUmVzdWx0KFtxdWVzdGlvbnNbMF1dLCB7XG4gICAgYWN0aW9uOiAnYWNjZXB0JyxcbiAgICBjb250ZW50OiB7XG4gICAgICBjb25maXJtOiAnTm9uZSBvZiB0aGUgYWJvdmUnLFxuICAgICAgY29uZmlybV9fbm90ZTogJ1dhbnQgYSBoeWJyaWQgcGF0aC4nLFxuICAgIH0sXG4gIH0pXG4gIGFzc2VydC5kZWVwRXF1YWwobm90ZUNhcnJ5aW5nLmFuc3dlcnMuY29uZmlybSwgeyBzZWxlY3RlZDogJ05vbmUgb2YgdGhlIGFib3ZlJywgbm90ZXM6ICdXYW50IGEgaHlicmlkIHBhdGguJyB9KVxufSlcblxudGVzdCgnaGVscGVyIGZvcm1hdHRpbmcgc3RheXMgYWxpZ25lZCB3aXRoIHRoZSB0b29sIGNvbnRyYWN0JywgKCkgPT4ge1xuICBjb25zdCBxdWVzdGlvbnMgPSBbXG4gICAge1xuICAgICAgaWQ6ICdmb2N1c19hcmVhcycsXG4gICAgICBoZWFkZXI6ICdGb2N1cycsXG4gICAgICBxdWVzdGlvbjogJ1doaWNoIGFyZWFzIG1hdHRlciBtb3N0PycsXG4gICAgICBhbGxvd011bHRpcGxlOiB0cnVlLFxuICAgICAgb3B0aW9uczogW1xuICAgICAgICB7IGxhYmVsOiAnRnJvbnRlbmQnLCBkZXNjcmlwdGlvbjogJ1ByaW9yaXRpemUgdGhlIFVJLicgfSxcbiAgICAgICAgeyBsYWJlbDogJ0JhY2tlbmQnLCBkZXNjcmlwdGlvbjogJ1ByaW9yaXRpemUgc2VydmVyIGxvZ2ljLicgfSxcbiAgICAgIF0sXG4gICAgfSxcbiAgXVxuXG4gIGNvbnN0IHJlcXVlc3QgPSBidWlsZEFza1VzZXJRdWVzdGlvbnNFbGljaXRSZXF1ZXN0KHF1ZXN0aW9ucylcbiAgYXNzZXJ0LmVxdWFsKHJlcXVlc3QubW9kZSwgJ2Zvcm0nKVxuICBhc3NlcnQub2socmVxdWVzdC5yZXF1ZXN0ZWRTY2hlbWEucHJvcGVydGllcy5mb2N1c19hcmVhcylcbiAgYXNzZXJ0Lm9rKCFyZXF1ZXN0LnJlcXVlc3RlZFNjaGVtYS5wcm9wZXJ0aWVzWydmb2N1c19hcmVhc19fbm90ZSddKVxuXG4gIGNvbnN0IGZvcm1hdHRlZCA9IGZvcm1hdEFza1VzZXJRdWVzdGlvbnNFbGljaXRSZXN1bHQocXVlc3Rpb25zLCB7XG4gICAgYWN0aW9uOiAnYWNjZXB0JyxcbiAgICBjb250ZW50OiB7XG4gICAgICBmb2N1c19hcmVhczogWydGcm9udGVuZCcsICdCYWNrZW5kJ10sXG4gICAgfSxcbiAgfSlcblxuICBhc3NlcnQuZXF1YWwoXG4gICAgZm9ybWF0dGVkLFxuICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGFuc3dlcnM6IHtcbiAgICAgICAgZm9jdXNfYXJlYXM6IHtcbiAgICAgICAgICBhbnN3ZXJzOiBbJ0Zyb250ZW5kJywgJ0JhY2tlbmQnXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSksXG4gIClcbn0pXG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsY0FBYztBQUN2QixTQUFTLHlCQUF5QjtBQUNsQyxTQUFTLDJCQUEyQjtBQUVwQztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUCxTQUFTLDJCQUEyQjtBQUNsQyxTQUFPO0FBQUEsSUFDTCxjQUFjLFlBQVk7QUFDeEIsWUFBTSxJQUFJLE1BQU0seUJBQXlCO0FBQUEsSUFDM0M7QUFBQSxJQUNBLFlBQVksTUFBTTtBQUFBLElBQ2xCLFdBQVcsTUFBTTtBQUFBLElBQ2pCLGVBQWUsWUFBWTtBQUFBLElBQUM7QUFBQSxJQUM1QixnQkFBZ0IsWUFBWTtBQUFBLElBQUM7QUFBQSxFQUMvQjtBQUNGO0FBRUEsZUFBZSxzQkFBc0IsU0FFbEM7QUFDRCxRQUFNLENBQUMsaUJBQWlCLGVBQWUsSUFBSSxrQkFBa0IsaUJBQWlCO0FBRTlFLFFBQU0sRUFBRSxPQUFPLElBQUksTUFBTSxnQkFBZ0IseUJBQXlCLENBQVU7QUFDNUUsUUFBTSxTQUFTLElBQUksT0FBTztBQUFBLElBQ3hCLE1BQU07QUFBQSxJQUNOLFNBQVM7QUFBQSxFQUNYLEdBQUc7QUFBQSxJQUNELGNBQWM7QUFBQSxNQUNaLGFBQWEsQ0FBQztBQUFBLElBQ2hCO0FBQUEsRUFDRixDQUFDO0FBRUQsTUFBSSxTQUFTLFVBQVU7QUFDckIsV0FBTyxrQkFBa0IscUJBQXFCLFFBQVEsUUFBUTtBQUFBLEVBQ2hFO0FBRUEsUUFBTSxRQUFRLElBQUk7QUFBQSxJQUNoQixPQUFPLFFBQVEsZUFBZTtBQUFBLElBQzlCLE9BQU8sUUFBUSxlQUFlO0FBQUEsRUFDaEMsQ0FBQztBQUVELFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQSxPQUFPLFlBQVk7QUFDakIsWUFBTSxPQUFPLE1BQU07QUFDbkIsWUFBTSxPQUFPLE1BQU07QUFBQSxJQUNyQjtBQUFBLEVBQ0Y7QUFDRjtBQUVBLEtBQUssZ0VBQWdFLFlBQVk7QUFDL0UsUUFBTSxFQUFFLFFBQVEsTUFBTSxJQUFJLE1BQU0sc0JBQXNCO0FBRXRELE1BQUk7QUFDRixVQUFNLFFBQVEsTUFBTSxPQUFPLFVBQVU7QUFDckMsV0FBTyxHQUFHLE1BQU0sTUFBTSxLQUFLLFVBQVEsS0FBSyxTQUFTLG9CQUFvQixDQUFDO0FBQUEsRUFDeEUsVUFBRTtBQUNBLFVBQU0sTUFBTTtBQUFBLEVBQ2Q7QUFDRixDQUFDO0FBRUQsS0FBSyxtRkFBbUYsWUFBWTtBQUNsRyxRQUFNLEVBQUUsUUFBUSxNQUFNLElBQUksTUFBTSxzQkFBc0I7QUFBQSxJQUNwRCxVQUFVLE9BQU8sWUFBWTtBQUMzQixZQUFNLGNBQWUsUUFLbEIsVUFBVTtBQUliLGFBQU8sTUFBTSxZQUFZLFNBQVMsc0NBQXNDO0FBQ3hFLGFBQU8sR0FBRyxZQUFZLGdCQUFnQixXQUFXLFVBQVU7QUFDM0QsYUFBTyxHQUFHLFlBQVksZ0JBQWdCLFdBQVcsa0JBQWtCLENBQUM7QUFDcEUsYUFBTyxHQUFHLFlBQVksZ0JBQWdCLFVBQVUsU0FBUyxZQUFZLENBQUM7QUFFdEUsYUFBTztBQUFBLFFBQ0wsUUFBUTtBQUFBLFFBQ1IsU0FBUztBQUFBLFVBQ1AsWUFBWTtBQUFBLFVBQ1osa0JBQWtCO0FBQUEsUUFDcEI7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELE1BQUk7QUFDRixVQUFNLFNBQVMsTUFBTSxPQUFPLFNBQVM7QUFBQSxNQUNuQyxNQUFNO0FBQUEsTUFDTixXQUFXO0FBQUEsUUFDVCxXQUFXO0FBQUEsVUFDVDtBQUFBLFlBQ0UsSUFBSTtBQUFBLFlBQ0osUUFBUTtBQUFBLFlBQ1IsVUFBVTtBQUFBLFlBQ1YsU0FBUztBQUFBLGNBQ1AsRUFBRSxPQUFPLFNBQVMsYUFBYSxtQkFBbUI7QUFBQSxjQUNsRCxFQUFFLE9BQU8sV0FBVyxhQUFhLG1DQUFtQztBQUFBLFlBQ3RFO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBRUQsVUFBTSxPQUFPLE9BQU8sUUFBUSxLQUFLLFVBQVEsS0FBSyxTQUFTLE1BQU07QUFDN0QsV0FBTyxHQUFHLFFBQVEsVUFBVSxJQUFJO0FBQ2hDLFdBQU87QUFBQSxNQUNMLEtBQUs7QUFBQSxNQUNMLEtBQUssVUFBVTtBQUFBLFFBQ2IsU0FBUztBQUFBLFVBQ1AsWUFBWTtBQUFBLFlBQ1YsU0FBUyxDQUFDLHFCQUFxQixvQ0FBb0M7QUFBQSxVQUNyRTtBQUFBLFFBQ0Y7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNIO0FBT0EsV0FBTztBQUFBLE1BQ0osT0FBMkM7QUFBQSxNQUM1QztBQUFBLFFBQ0UsV0FBVztBQUFBLFVBQ1Q7QUFBQSxZQUNFLElBQUk7QUFBQSxZQUNKLFFBQVE7QUFBQSxZQUNSLFVBQVU7QUFBQSxZQUNWLFNBQVM7QUFBQSxjQUNQLEVBQUUsT0FBTyxTQUFTLGFBQWEsbUJBQW1CO0FBQUEsY0FDbEQsRUFBRSxPQUFPLFdBQVcsYUFBYSxtQ0FBbUM7QUFBQSxZQUN0RTtBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBQUEsUUFDQSxVQUFVO0FBQUEsVUFDUixjQUFjO0FBQUEsVUFDZCxTQUFTO0FBQUEsWUFDUCxZQUFZLEVBQUUsVUFBVSxxQkFBcUIsT0FBTywwQkFBMEI7QUFBQSxVQUNoRjtBQUFBLFFBQ0Y7QUFBQSxRQUNBLFdBQVc7QUFBQSxNQUNiO0FBQUEsSUFDRjtBQUFBLEVBQ0YsVUFBRTtBQUNBLFVBQU0sTUFBTTtBQUFBLEVBQ2Q7QUFDRixDQUFDO0FBRUQsS0FBSyxrRkFBa0YsWUFBWTtBQUNqRyxRQUFNLEVBQUUsUUFBUSxNQUFNLElBQUksTUFBTSxzQkFBc0I7QUFBQSxJQUNwRCxVQUFVLGFBQWE7QUFBQSxNQUNyQixRQUFRO0FBQUEsTUFDUixTQUFTLEVBQUUsU0FBUyxnQ0FBZ0M7QUFBQSxJQUN0RDtBQUFBLEVBQ0YsQ0FBQztBQUVELE1BQUk7QUFDRixVQUFNLFNBQVMsTUFBTSxPQUFPLFNBQVM7QUFBQSxNQUNuQyxNQUFNO0FBQUEsTUFDTixXQUFXO0FBQUEsUUFDVCxXQUFXO0FBQUEsVUFDVDtBQUFBLFlBQ0UsSUFBSTtBQUFBLFlBQ0osUUFBUTtBQUFBLFlBQ1IsVUFBVTtBQUFBLFlBQ1YsU0FBUztBQUFBLGNBQ1AsRUFBRSxPQUFPLGlDQUFpQyxhQUFhLFdBQVc7QUFBQSxjQUNsRSxFQUFFLE9BQU8sbUNBQThCLGFBQWEsVUFBVTtBQUFBLFlBQ2hFO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBRUQsV0FBTztBQUFBLE1BQ0osT0FBMkM7QUFBQSxNQUM1QztBQUFBLFFBQ0UsV0FBVztBQUFBLFVBQ1Q7QUFBQSxZQUNFLElBQUk7QUFBQSxZQUNKLFFBQVE7QUFBQSxZQUNSLFVBQVU7QUFBQSxZQUNWLFNBQVM7QUFBQSxjQUNQLEVBQUUsT0FBTyxpQ0FBaUMsYUFBYSxXQUFXO0FBQUEsY0FDbEUsRUFBRSxPQUFPLG1DQUE4QixhQUFhLFVBQVU7QUFBQSxZQUNoRTtBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBQUEsUUFDQSxVQUFVO0FBQUEsVUFDUixjQUFjO0FBQUEsVUFDZCxTQUFTO0FBQUEsWUFDUCxTQUFTLEVBQUUsVUFBVSxpQ0FBaUMsT0FBTyxHQUFHO0FBQUEsVUFDbEU7QUFBQSxRQUNGO0FBQUEsUUFDQSxXQUFXO0FBQUEsTUFDYjtBQUFBLElBQ0Y7QUFBQSxFQUNGLFVBQUU7QUFDQSxVQUFNLE1BQU07QUFBQSxFQUNkO0FBQ0YsQ0FBQztBQUVELEtBQUssaUZBQWlGLFlBQVk7QUFDaEcsUUFBTSxFQUFFLFFBQVEsTUFBTSxJQUFJLE1BQU0sc0JBQXNCO0FBQUEsSUFDcEQsVUFBVSxhQUFhO0FBQUEsTUFDckIsUUFBUTtBQUFBLE1BQ1IsU0FBUyxFQUFFLE9BQU8sQ0FBQyxZQUFZLFNBQVMsRUFBRTtBQUFBLElBQzVDO0FBQUEsRUFDRixDQUFDO0FBRUQsTUFBSTtBQUNGLFVBQU0sU0FBUyxNQUFNLE9BQU8sU0FBUztBQUFBLE1BQ25DLE1BQU07QUFBQSxNQUNOLFdBQVc7QUFBQSxRQUNULFdBQVc7QUFBQSxVQUNUO0FBQUEsWUFDRSxJQUFJO0FBQUEsWUFDSixRQUFRO0FBQUEsWUFDUixVQUFVO0FBQUEsWUFDVixlQUFlO0FBQUEsWUFDZixTQUFTO0FBQUEsY0FDUCxFQUFFLE9BQU8sWUFBWSxhQUFhLFdBQVc7QUFBQSxjQUM3QyxFQUFFLE9BQU8sV0FBVyxhQUFhLGVBQWU7QUFBQSxjQUNoRCxFQUFFLE9BQU8sU0FBUyxhQUFhLFlBQVk7QUFBQSxZQUM3QztBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUFBLElBQ0YsQ0FBQztBQUVELFVBQU0sYUFBYyxPQUFzSDtBQUMxSSxXQUFPLFVBQVUsWUFBWSxVQUFVLFNBQVMsT0FBTyxFQUFFLFVBQVUsQ0FBQyxZQUFZLFNBQVMsR0FBRyxPQUFPLEdBQUcsQ0FBQztBQUN2RyxXQUFPLE1BQU8sT0FBMkQsbUJBQW1CLFdBQVcsS0FBSztBQUFBLEVBQzlHLFVBQUU7QUFDQSxVQUFNLE1BQU07QUFBQSxFQUNkO0FBQ0YsQ0FBQztBQUVELEtBQUssNEVBQTRFLFlBQVk7QUFDM0YsUUFBTSxFQUFFLFFBQVEsTUFBTSxJQUFJLE1BQU0sc0JBQXNCO0FBRXRELE1BQUk7QUFDRixVQUFNLFNBQVMsTUFBTSxPQUFPLFNBQVM7QUFBQSxNQUNuQyxNQUFNO0FBQUEsTUFDTixXQUFXO0FBQUEsUUFDVCxXQUFXO0FBQUEsVUFDVDtBQUFBLFlBQ0UsSUFBSTtBQUFBLFlBQ0osUUFBUTtBQUFBLFlBQ1IsVUFBVTtBQUFBLFlBQ1YsU0FBUyxDQUFDO0FBQUEsVUFDWjtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBRUQsVUFBTSxPQUFPLE9BQU8sUUFBUSxLQUFLLFVBQVEsS0FBSyxTQUFTLE1BQU07QUFDN0QsV0FBTyxHQUFHLFFBQVEsVUFBVSxJQUFJO0FBQ2hDLFdBQU8sTUFBTSxPQUFPLFNBQVMsSUFBSTtBQUNqQyxXQUFPLE1BQU0sS0FBSyxNQUFNLDZCQUE2QjtBQUFBLEVBQ3ZELFVBQUU7QUFDQSxVQUFNLE1BQU07QUFBQSxFQUNkO0FBQ0YsQ0FBQztBQUVELEtBQUssb0ZBQW9GLFlBQVk7QUFDbkcsUUFBTSxFQUFFLFFBQVEsTUFBTSxJQUFJLE1BQU0sc0JBQXNCO0FBQUEsSUFDcEQsVUFBVSxhQUFhO0FBQUEsTUFDckIsUUFBUTtBQUFBLElBQ1Y7QUFBQSxFQUNGLENBQUM7QUFFRCxNQUFJO0FBQ0YsVUFBTSxTQUFTLE1BQU0sT0FBTyxTQUFTO0FBQUEsTUFDbkMsTUFBTTtBQUFBLE1BQ04sV0FBVztBQUFBLFFBQ1QsV0FBVztBQUFBLFVBQ1Q7QUFBQSxZQUNFLElBQUk7QUFBQSxZQUNKLFFBQVE7QUFBQSxZQUNSLFVBQVU7QUFBQSxZQUNWLFNBQVM7QUFBQSxjQUNQLEVBQUUsT0FBTyxPQUFPLGFBQWEsV0FBVztBQUFBLGNBQ3hDLEVBQUUsT0FBTyxNQUFNLGFBQWEsYUFBYTtBQUFBLFlBQzNDO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBRUQsVUFBTSxPQUFPLE9BQU8sUUFBUSxLQUFLLFVBQVEsS0FBSyxTQUFTLE1BQU07QUFDN0QsV0FBTyxHQUFHLFFBQVEsVUFBVSxJQUFJO0FBQ2hDLFdBQU8sTUFBTSxLQUFLLE1BQU0sOERBQThEO0FBTXRGLFdBQU87QUFBQSxNQUNKLE9BQTJDO0FBQUEsTUFDNUM7QUFBQSxRQUNFLFdBQVc7QUFBQSxVQUNUO0FBQUEsWUFDRSxJQUFJO0FBQUEsWUFDSixRQUFRO0FBQUEsWUFDUixVQUFVO0FBQUEsWUFDVixTQUFTO0FBQUEsY0FDUCxFQUFFLE9BQU8sT0FBTyxhQUFhLFdBQVc7QUFBQSxjQUN4QyxFQUFFLE9BQU8sTUFBTSxhQUFhLGFBQWE7QUFBQSxZQUMzQztBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBQUEsUUFDQSxVQUFVO0FBQUEsUUFDVixXQUFXO0FBQUEsTUFDYjtBQUFBLElBQ0Y7QUFBQSxFQUNGLFVBQUU7QUFDQSxVQUFNLE1BQU07QUFBQSxFQUNkO0FBQ0YsQ0FBQztBQUVELEtBQUssNEZBQTRGLFlBQVk7QUFDM0csUUFBTSxNQUFNLE1BQU0sT0FBTyx5Q0FBeUM7QUFHbEUsUUFBTSxtQ0FBbUMsSUFBSTtBQUM3QyxTQUFPLE1BQU0sT0FBTyxrQ0FBa0MsWUFBWSxzR0FBc0c7QUFFeEssUUFBTSxZQUFZO0FBQUEsSUFDaEIsRUFBRSxJQUFJLFdBQVcsUUFBUSxXQUFXLFVBQVUsWUFBWSxTQUFTO0FBQUEsTUFDakUsRUFBRSxPQUFPLE9BQU8sYUFBYSxNQUFNO0FBQUEsTUFDbkMsRUFBRSxPQUFPLE1BQU0sYUFBYSxRQUFRO0FBQUEsSUFDdEMsRUFBRTtBQUFBLElBQ0YsRUFBRSxJQUFJLFNBQVMsUUFBUSxTQUFTLFVBQVUsZUFBZSxlQUFlLE1BQU0sU0FBUztBQUFBLE1BQ3JGLEVBQUUsT0FBTyxZQUFZLGFBQWEsV0FBVztBQUFBLE1BQzdDLEVBQUUsT0FBTyxXQUFXLGFBQWEsZUFBZTtBQUFBLElBQ2xELEVBQUU7QUFBQSxFQUNKO0FBRUEsUUFBTSxXQUFXLGlDQUFpQyxXQUFXO0FBQUEsSUFDM0QsUUFBUTtBQUFBLElBQ1IsU0FBUztBQUFBLE1BQ1AsU0FBUztBQUFBLE1BQ1QsT0FBTyxDQUFDLFlBQVksU0FBUztBQUFBLElBQy9CO0FBQUEsRUFDRixDQUFDO0FBQ0QsU0FBTyxVQUFVLFVBQVU7QUFBQSxJQUN6QixjQUFjO0FBQUEsSUFDZCxTQUFTO0FBQUEsTUFDUCxTQUFTLEVBQUUsVUFBVSxPQUFPLE9BQU8sR0FBRztBQUFBLE1BQ3RDLE9BQU8sRUFBRSxVQUFVLENBQUMsWUFBWSxTQUFTLEdBQUcsT0FBTyxHQUFHO0FBQUEsSUFDeEQ7QUFBQSxFQUNGLENBQUM7QUFFRCxRQUFNLGVBQWUsaUNBQWlDLENBQUMsVUFBVSxDQUFDLENBQUMsR0FBRztBQUFBLElBQ3BFLFFBQVE7QUFBQSxJQUNSLFNBQVM7QUFBQSxNQUNQLFNBQVM7QUFBQSxNQUNULGVBQWU7QUFBQSxJQUNqQjtBQUFBLEVBQ0YsQ0FBQztBQUNELFNBQU8sVUFBVSxhQUFhLFFBQVEsU0FBUyxFQUFFLFVBQVUscUJBQXFCLE9BQU8sc0JBQXNCLENBQUM7QUFDaEgsQ0FBQztBQUVELEtBQUssMERBQTBELE1BQU07QUFDbkUsUUFBTSxZQUFZO0FBQUEsSUFDaEI7QUFBQSxNQUNFLElBQUk7QUFBQSxNQUNKLFFBQVE7QUFBQSxNQUNSLFVBQVU7QUFBQSxNQUNWLGVBQWU7QUFBQSxNQUNmLFNBQVM7QUFBQSxRQUNQLEVBQUUsT0FBTyxZQUFZLGFBQWEscUJBQXFCO0FBQUEsUUFDdkQsRUFBRSxPQUFPLFdBQVcsYUFBYSwyQkFBMkI7QUFBQSxNQUM5RDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBRUEsUUFBTSxVQUFVLG1DQUFtQyxTQUFTO0FBQzVELFNBQU8sTUFBTSxRQUFRLE1BQU0sTUFBTTtBQUNqQyxTQUFPLEdBQUcsUUFBUSxnQkFBZ0IsV0FBVyxXQUFXO0FBQ3hELFNBQU8sR0FBRyxDQUFDLFFBQVEsZ0JBQWdCLFdBQVcsbUJBQW1CLENBQUM7QUFFbEUsUUFBTSxZQUFZLG1DQUFtQyxXQUFXO0FBQUEsSUFDOUQsUUFBUTtBQUFBLElBQ1IsU0FBUztBQUFBLE1BQ1AsYUFBYSxDQUFDLFlBQVksU0FBUztBQUFBLElBQ3JDO0FBQUEsRUFDRixDQUFDO0FBRUQsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBLEtBQUssVUFBVTtBQUFBLE1BQ2IsU0FBUztBQUFBLFFBQ1AsYUFBYTtBQUFBLFVBQ1gsU0FBUyxDQUFDLFlBQVksU0FBUztBQUFBLFFBQ2pDO0FBQUEsTUFDRjtBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0g7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
