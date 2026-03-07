import { NextRequest, NextResponse } from "next/server";

/**
 * Placeholder API for cloud Playwright step execution. Accepts JSON body with sessionId and payload;
 * returns 400 if missing. Returns 501 (Not Implemented) when cloud execution is not configured.
 */
export async function POST(request: NextRequest) {
  try {
    let body: { sessionId?: string; payload?: unknown } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const { sessionId, payload } = body;
    if (!sessionId || payload === undefined) {
      return NextResponse.json(
        { success: false, error: "Missing sessionId or payload" },
        { status: 400 }
      );
    }

    // TODO: Forward to your Playwright worker (e.g. queue job, HTTP to container)
    return NextResponse.json(
      {
        success: false,
        error: "Cloud execution not configured. Implement backend worker.",
        pageContext: undefined,
      },
      { status: 501 }
    );
  } catch (err) {
    console.error("[api/run-step]", err);
    return NextResponse.json(
      { success: false, error: "Something went wrong" },
      { status: 500 }
    );
  }
}
