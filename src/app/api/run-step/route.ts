import { NextRequest, NextResponse } from "next/server";

/**
 * Placeholder API for cloud Playwright step execution. Accepts JSON body with sessionId and payload;
 * returns 400 if missing. Replace with actual call to your remote Playwright workers.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { sessionId, payload } = body;

    if (!sessionId || !payload) {
      return NextResponse.json(
        { success: false, error: "Missing sessionId or payload" },
        { status: 400 }
      );
    }

    // TODO: Forward to your Playwright worker (e.g. queue job, HTTP to container)
    // const result = await playwrightWorker.execute(sessionId, payload);

    return NextResponse.json({
      success: false,
      error: "Cloud execution not configured. Implement backend worker.",
      pageContext: undefined,
    });
  } catch (err) {
    console.error("[api/run-step]", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
