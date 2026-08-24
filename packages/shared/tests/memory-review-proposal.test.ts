import { describe, expect, test } from "bun:test";
import cases from "../fixtures/memory-review-proposal-cases.json" with { type: "json" };
import { validateMemoryReviewProposal } from "../src/memory-review-proposal.js";

interface Case {
  name: string;
  valid: boolean;
  proposal: Record<string, unknown>;
  expandField?: { path: string; repeat: number };
}

describe("strict memory review proposal schema", () => {
  for (const testCase of cases as Case[]) {
    test(testCase.name, () => {
      const proposal = { ...testCase.proposal };
      if (testCase.expandField) {
        proposal[testCase.expandField.path] = (proposal[testCase.expandField.path] as string).repeat(testCase.expandField.repeat);
      }
      if (testCase.valid) {
        expect(() => validateMemoryReviewProposal(proposal)).not.toThrow();
      } else {
        expect(() => validateMemoryReviewProposal(proposal)).toThrow();
      }
    });
  }

  test("rejects a non-object payload", () => {
    expect(() => validateMemoryReviewProposal("not an object")).toThrow();
    expect(() => validateMemoryReviewProposal(null)).toThrow();
    expect(() => validateMemoryReviewProposal([1, 2, 3])).toThrow();
  });

  test("rejects a proposal that escalates target via prototype pollution shape", () => {
    const hostile = JSON.parse('{"decision":"create","target":"managed_memory","topic":"a","evidence":[],"content":"c","reason":"r","freshness":"standing","__proto__":{"polluted":true}}');
    expect(() => validateMemoryReviewProposal(hostile)).toThrow();
  });

  test("rejects content carrying a quoted-JSON-style credential shape, not just bare key: value prose", () => {
    const withPassword = {
      decision: "create", target: "managed_memory", topic: "a", evidence: [],
      content: 'user shared config: {"password": "hunter2value"}', reason: "r", freshness: "standing"
    };
    expect(() => validateMemoryReviewProposal(withPassword)).toThrow("credential-shaped");

    const withApiKey = {
      decision: "create", target: "managed_memory", topic: "a", evidence: [],
      content: "c", reason: 'saw header {"api_key":"abcdefghij1234567890zzzz"}', freshness: "standing"
    };
    expect(() => validateMemoryReviewProposal(withApiKey)).toThrow("credential-shaped");
  });
});
