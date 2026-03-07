import type { ISelfHealingHeuristic, SelfHealingContext, SelfHealingResult } from "./types";
import type { PlaywrightStepPayload } from "@/types/execution";

/**
 * Default self-healing: fuzzy text match selector and optional visual coordinate fallback.
 * Designed to be swappable with an AI-based heuristic (e.g. LLM + vision) later.
 */
export class DefaultSelfHealingHeuristic implements ISelfHealingHeuristic {
  /** Tries recovery in order: fuzzy selector from instruction, page-context match, then visual fallback. */
  async attemptRecovery(context: SelfHealingContext): Promise<SelfHealingResult> {
    const { instruction, failedPayload, pageContext } = context;

    // 1) Fuzzy text match: derive a likely selector from instruction text
    const fuzzyPayload = this.tryFuzzySelector(instruction, failedPayload);
    if (fuzzyPayload) {
      return {
        recovered: true,
        payload: fuzzyPayload,
        reason: "Fuzzy match selector from instruction text",
      };
    }

    // 2) If we had page context (e.g. DOM), could run more advanced matching here
    if (pageContext) {
      const fromContext = this.tryFromPageContext(instruction, failedPayload, pageContext);
      if (fromContext) return fromContext;
    }

    // 3) Visual fallback: could use screenshot + coordinate suggestion (placeholder)
    // In production, integrate with visual regression or AI vision API
    const visualPayload = this.tryVisualFallback(context);
    if (visualPayload) {
      return {
        recovered: true,
        payload: visualPayload,
        reason: "Visual coordinate fallback",
      };
    }

    return { recovered: false };
  }

  /** Builds an alternative selector from instruction text (e.g. "Click Submit" -> button/link with text "Submit"). */
  private tryFuzzySelector(
    instruction: string,
    failed: PlaywrightStepPayload
  ): PlaywrightStepPayload | null {
    const lower = instruction.toLowerCase();
    // Extract likely button/link text (e.g. "Click Submit" -> "Submit")
    const clickMatch = lower.match(/click\s+(.+)/);
    const fillMatch = lower.match(/fill\s+(.+?)\s+with/);
    const text = clickMatch?.[1]?.trim() ?? fillMatch?.[1]?.trim();
    if (!text) return null;

    // Prefer role + name for accessibility-friendly selector
    const selector = `[role="button"]:has-text("${text}"), button:has-text("${text}"), a:has-text("${text}"), [type="submit"]:has-text("${text}")`;
    return {
      ...failed,
      selector,
      text,
    };
  }

  /** Placeholder: would parse DOM (pageContext) to find elements by text/role; currently returns null. */
  private tryFromPageContext(
    _instruction: string,
    _failed: PlaywrightStepPayload,
    _pageContext: string
  ): SelfHealingResult | null {
    // Placeholder: parse DOM and find elements by text/role (could use JSDOM or similar)
    // For now we only use fuzzy from instruction
    return null;
  }

  /** Placeholder: would use screenshot/vision API for coordinate-based fallback; currently returns null. */
  private tryVisualFallback(_ctx: SelfHealingContext): PlaywrightStepPayload | null {
    // Placeholder: if screenshot is available, could return a coordinate-based action
    // or call out to vision API for element location
    return null;
  }
}

export const defaultHeuristic = new DefaultSelfHealingHeuristic();
