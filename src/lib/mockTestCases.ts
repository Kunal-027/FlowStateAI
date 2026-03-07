import type { TestCase } from "@/types/execution";
import { parseInstructionsToSteps } from "@/lib/parser";

/** Generates a unique id for test cases. */
function id(): string {
  return `tc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Returns a mock list of test cases for the sidebar when none exist.
 * Each case has a name, status "queued", and parsed steps.
 */
export function getMockTestCases(): TestCase[] {
  const googleInstructions = [
    "navigate https://www.google.com",
    "fill search with FlowState AI",
    "click Submit",
  ];
  const instructions1 = [
    "navigate https://example.com",
    "click More information",
    "assert Example Domain",
  ];
  const instructions2 = [
    "navigate https://example.com",
    "fill search with test query",
    "click Submit",
  ];
  const instructions3 = [
    "navigate https://example.com",
    "hover More information",
    "wait 1 second",
  ];

  return [
    {
      id: id(),
      name: "Google Test",
      steps: parseInstructionsToSteps(googleInstructions.map((instruction, order) => ({ instruction, order }))),
      status: "queued",
    },
    {
      id: id(),
      name: "Example navigation",
      steps: parseInstructionsToSteps(instructions1.map((instruction, order) => ({ instruction, order }))),
      status: "queued",
    },
    {
      id: id(),
      name: "Search flow",
      steps: parseInstructionsToSteps(instructions2.map((instruction, order) => ({ instruction, order }))),
      status: "queued",
    },
    {
      id: id(),
      name: "Hover and wait",
      steps: parseInstructionsToSteps(instructions3.map((instruction, order) => ({ instruction, order }))),
      status: "queued",
    },
  ];
}
