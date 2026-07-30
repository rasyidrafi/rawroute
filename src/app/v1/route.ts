const gatewayInfo = {
  service: "rawroute",
  status: "ok",
  description: "Protocol-preserving AI gateway",
  endpoints: {
    models: "GET /v1/models",
    litellmModelInfo: "GET /v1/model/info",
    openaiChatCompletions: "POST /v1/chat/completions",
    openaiResponses: "POST /v1/responses",
    anthropicMessages: "POST /v1/messages",
  },
}

export function GET() {
  return Response.json(gatewayInfo)
}
