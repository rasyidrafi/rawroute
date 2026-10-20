export async function GET() {
  return Response.json({
    service: "rawroute",
    backend: "cliproxyapi",
    endpoints: {
      models: "GET /v1/models",
      chatCompletions: "POST /v1/chat/completions",
      responses: "POST /v1/responses",
      messages: "POST /v1/messages",
    },
  })
}

