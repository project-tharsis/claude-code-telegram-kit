import { describe, expect, test } from "bun:test";
import cases from "../fixtures/memory-review-proposal-cases.json" with { type: "json" };
import { MEMORY_REVIEW_PROPOSAL_JSON_SCHEMA, validateMemoryReviewProposal } from "../src/memory-review-proposal.js";

test("Claude Code wire schema uses only supported structured-output constraints", () => {
  const schema = JSON.parse(MEMORY_REVIEW_PROPOSAL_JSON_SCHEMA) as Record<string, any>;
  const serialized = JSON.stringify(schema);
  expect(serialized).not.toMatch(/maxLength|maxItems|minLength|minItems/);
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toHaveLength(7);
});

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

  test("keeps strict host-side bounds after wire-only constraints are removed", () => {
    const base = {
      decision: "create", target: "managed_memory", topic: "a", evidence: ["e"],
      content: "c", reason: "r", freshness: "standing"
    };
    expect(() => validateMemoryReviewProposal({ ...base, topic: "a".repeat(65) })).toThrow();
    expect(() => validateMemoryReviewProposal({ ...base, evidence: Array(9).fill("e") })).toThrow();
    expect(() => validateMemoryReviewProposal({ ...base, evidence: ["e".repeat(161)] })).toThrow();
    expect(() => validateMemoryReviewProposal({ ...base, content: "c".repeat(4001) })).toThrow();
    expect(() => validateMemoryReviewProposal({ ...base, reason: "r".repeat(401) })).toThrow();
  });

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
