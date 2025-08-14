import { MODEL } from "@/config/constants";
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

export async function POST(request: Request) {
  try {
    const { messages, tools } = await request.json();
    console.log("Received messages:", messages);

    const openai = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL,
    });

    // Filter out messages with empty content
    const filteredMessages = messages.filter((msg: any) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const hasValidContent = msg.content.some((c: any) => 
          c.text && c.text.trim().length > 0
        );
        return hasValidContent;
      }
      return true;
    });

    const requestPayload = {
      model: MODEL,
      input: filteredMessages,
      tools,
      stream: true,
      parallel_tool_calls: false,
    };

    console.log("\x1b[34m[Responses API Request]", JSON.stringify(requestPayload, null, 2), "\x1b[0m");

    const events = await openai.responses.create(requestPayload);

    // File logging setup
    let respId: string | null = null;
    let logDir: string | null = null;
    let eventsLog: string[] = [];

    if (process.env.LOG_DIR) {
      logDir = process.env.LOG_DIR;
      // Ensure log directory exists
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
    }

    // Create a ReadableStream that emits SSE data
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of events) {
            // Log all events from Responses API
            console.log(`\x1b[32m[Responses API Event] ${event.type}:`, JSON.stringify(event, null, 2), "\x1b[0m");
            
            // Extract response ID from the first event and save request
            if (!respId && event.type === "response.created" && event.response?.id) {
              respId = event.response.id;
              if (logDir) {
                const reqFilePath = join(logDir, `req-${respId}.json`);
                writeFileSync(reqFilePath, JSON.stringify(requestPayload, null, 2));
              }
            }
            
            // Collect events for logging
            if (logDir) {
              // Reorder fields to put "type", "sequence_number", and "output_index" first
              const { type, sequence_number, output_index, ...rest } = event as any;
              const reorderedEvent: any = { type };
              if (sequence_number !== undefined) reorderedEvent.sequence_number = sequence_number;
              if (output_index !== undefined) reorderedEvent.output_index = output_index;
              Object.assign(reorderedEvent, rest);
              eventsLog.push(JSON.stringify(reorderedEvent, null, 2));
            }
            
            // Sending all events to the client
            const data = JSON.stringify({
              event: event.type,
              data: event,
            });
            controller.enqueue(`data: ${data}\n\n`);
          }
          
          // Save response events log
          if (logDir && respId) {
            const respFilePath = join(logDir, `resp-${respId}.json`);
            writeFileSync(respFilePath, eventsLog.join('\n\n'));
          }
          
          // End of stream
          controller.close();
        } catch (error) {
          console.error("Error in streaming loop:", error);
          controller.error(error);
        }
      },
    });

    // Return the ReadableStream as SSE
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("Error in POST handler:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
